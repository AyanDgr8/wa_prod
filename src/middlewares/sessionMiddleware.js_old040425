// src/middleware/sessionMiddleware.js
import connectDB from '../db/index.js';
import jwt from 'jsonwebtoken';
import { logger } from '../logger.js';

export const validateSession = async (req, res, next) => {
    // List of paths that don't require session validation
    const excludedPaths = ['/login', '/logout', '/check-session', '/forgot-password', '/reset-password'];
    
    if (excludedPaths.includes(req.path)) {
        return next();
    }

    const token = req.headers.authorization?.split(' ')[1];
    const deviceId = req.headers['x-device-id'];

    if (!token || !deviceId) {
        logger.warn('Missing token or device ID');
        return res.status(401).json({ 
            message: 'Authentication required',
            forceLogout: true
        });
    }

    let connection;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        connection = await connectDB();

        // Use a shorter transaction with retry logic
        let retries = 3;
        while (retries > 0) {
            try {
                await connection.beginTransaction();

                // First, clean up old sessions
                await connection.execute(
                    'UPDATE login_history SET is_active = false, logout_time = NOW() WHERE user_id = ? AND is_active = true AND (TIMESTAMPDIFF(HOUR, login_time, NOW()) >= 24 OR device_id != ?)',
                    [decoded.userId, deviceId]
                );

                // Get active session for this user and device
                const [sessions] = await connection.execute(
                    'SELECT * FROM login_history WHERE user_id = ? AND device_id = ? AND is_active = true AND TIMESTAMPDIFF(HOUR, login_time, NOW()) < 24 ORDER BY login_time DESC LIMIT 1',
                    [decoded.userId, deviceId]
                );

                if (sessions.length === 0) {
                    // Create a new session for this device
                    await connection.execute(
                        'INSERT INTO login_history (user_id, device_id, login_time, is_active) VALUES (?, ?, NOW(), true)',
                        [decoded.userId, deviceId]
                    );
                    
                    logger.info(`Created new session for user ${decoded.userId} on device ${deviceId}`);
                } else {
                    // Update last activity time for existing session
                    await connection.execute(
                        'UPDATE login_history SET login_time = NOW() WHERE id = ?',
                        [sessions[0].id]
                    );
                    
                    logger.info(`Updated session ${sessions[0].id} for user ${decoded.userId}`);
                }

                // No active sessions found, allow new session
                req.userId = decoded.userId;
                await connection.commit();
                break; // Success, exit retry loop
            } catch (deadlockError) {
                if (deadlockError.code === 'ER_LOCK_DEADLOCK' || deadlockError.code === 'ER_LOCK_WAIT_TIMEOUT') {
                    await connection.rollback();
                    retries--;
                    if (retries === 0) {
                        throw new Error('Max retries reached for session validation');
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries))); // Exponential backoff
                } else {
                    throw deadlockError; // Re-throw if it's not a deadlock error
                }
            }
        }
        next();
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                logger.error('Error rolling back transaction:', rollbackError);
            }
        }
        
        logger.error('Session validation error:', error);
        
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({
                message: 'Invalid or expired token',
                forceLogout: true
            });
        }
        
        return res.status(500).json({ 
            message: 'An error occurred during session validation',
            forceLogout: true
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseError) {
                logger.error('Error releasing connection:', releaseError);
            }
        }
    }
};
