// src/controllers/updateStatus.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

// Valid ENUM values for `message_status`
const MESSAGE_STATUS = {
    PENDING: 'pending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed'
};

// Function to get database ID from WhatsApp message ID
const getDatabaseId = async (instanceId, messageId) => {
    try {
        const connection = await connectDB();
        const query = `SELECT id FROM media_messages WHERE instance_id = ? AND whatsapp_message_id = ?`;
        const [rows] = await connection.query(query, [instanceId, messageId]);
        
        const found = rows.length > 0;
        const dbId = found ? rows[0].id : null;
        
        logger.info('Database lookup result:', {
            instanceId,
            messageId,
            dbId,
            found,
            timestamp: new Date().toISOString()
        });
        
        return { found, dbId };
    } catch (error) {
        logger.error('Failed to get database ID:', error);
        return { found: false, dbId: null };
    }
};

// Function to update message status in the database
export const updateMessageStatusInDB = async (messageId, newStatus) => {
    // Validate status
    if (!Object.values(MESSAGE_STATUS).includes(newStatus)) {
        logger.warn(`Invalid message status: ${newStatus}, defaulting to 'sent'`);
        newStatus = MESSAGE_STATUS.SENT;
    }

    let connection;
    const pool = await connectDB();
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // First, get message details
        const [messageRows] = await connection.query(
            'SELECT whatsapp_message_id, instance_id, recipient, created_at FROM media_messages WHERE id = ?',
            [messageId]
        );

        if (messageRows.length === 0) {
            logger.warn(`No message found with ID ${messageId}`);
            return;
        }

        const { whatsapp_message_id, instance_id, recipient, created_at } = messageRows[0];

        // Update status in media_messages
        const updateQuery = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.execute(updateQuery, [newStatus, messageId]);

        // Update report_time table
        if (whatsapp_message_id && result.affectedRows > 0) {
            const reportTimeQuery = `
                INSERT INTO report_time 
                    (instance_id, recipient, whatsapp_message_id, initiated_time, sent_time, delivered_time, read_time, failed_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    sent_time = CASE 
                        WHEN ? = 'sent' AND sent_time IS NULL THEN CURRENT_TIMESTAMP()
                        ELSE sent_time
                    END,
                    delivered_time = CASE 
                        WHEN ? = 'delivered' AND delivered_time IS NULL THEN CURRENT_TIMESTAMP()
                        ELSE delivered_time
                    END,
                    read_time = CASE 
                        WHEN ? = 'read' AND read_time IS NULL THEN CURRENT_TIMESTAMP()
                        ELSE read_time
                    END,
                    failed_time = CASE 
                        WHEN ? = 'failed' AND failed_time IS NULL THEN CURRENT_TIMESTAMP()
                        ELSE failed_time
                    END
            `;

            await connection.execute(reportTimeQuery, [
                instance_id,
                recipient,
                whatsapp_message_id,
                created_at, // initiated_time
                newStatus === 'sent' ? created_at : null, // sent_time
                newStatus === 'delivered' ? new Date() : null, // delivered_time
                newStatus === 'read' ? new Date() : null, // read_time
                newStatus === 'failed' ? new Date() : null, // failed_time
                newStatus, // For sent check
                newStatus, // For delivered check
                newStatus, // For read check
                newStatus  // For failed check
            ]);

            logger.info(`Message status and report times updated successfully`, {
                messageId,
                newStatus,
                timestamp: new Date().toISOString()
            });
        } else {
            logger.warn(`No message found with ID ${messageId} or no WhatsApp message ID`);
        }

        await connection.commit();
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        logger.error('Failed to update message status in DB:', {
            error: error.message,
            messageId,
            newStatus
        });
        throw error;
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

// Function to setup message status tracking for a WhatsApp instance
export const setupMessageStatusTracking = (sock, instanceId) => {
    if (!sock || !instanceId) {
        logger.error('Invalid socket or instanceId provided for status tracking');
        return;
    }

    // Track message status updates
    sock.ev.on('messages.update', async updates => {
        logger.info('Received messages.update:', { updates });
        
        for (const update of updates) {
            if (!update.key || !update.update) continue;

            const messageId = update.key.id;
            const remoteJid = update.key.remoteJid;
            
            // Log the raw update
            logger.info('Processing message update:', {
                messageId,
                remoteJid,
                update: update.update,
                timestamp: new Date().toISOString()
            });

            // Check message status
            if (update.update.status !== undefined) {
                logger.info('Processing status code:', {
                    status: update.update.status,
                    messageId,
                    timestamp: new Date().toISOString()
                });

                // Get database ID for this WhatsApp message
                const { found, dbId } = await getDatabaseId(instanceId, messageId);
                
                if (!found) {
                    logger.warn('Message not found in database:', {
                        instanceId,
                        messageId,
                        timestamp: new Date().toISOString()
                    });
                    continue;
                }

                let newStatus;
                const currentTime = new Date();
                switch (update.update.status) {
                    case 'PENDING':
                    case 1:
                        newStatus = MESSAGE_STATUS.PENDING;
                        break;
                    case 3: // Delivered
                        newStatus = MESSAGE_STATUS.DELIVERED;
                        // Add a small delay before updating to ensure proper sequence
                        await new Promise(resolve => setTimeout(resolve, 500));
                        break;
                    case 4: // Read
                        newStatus = MESSAGE_STATUS.READ;
                        // Add a small delay before updating to ensure proper sequence
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        break;
                    case -1: // Failed
                        newStatus = MESSAGE_STATUS.FAILED;
                        break;
                    default:
                        newStatus = MESSAGE_STATUS.SENT;
                }

                // Update status in database
                await updateMessageStatusInDB(dbId, newStatus);
                
                logger.info('Message status updated successfully', {
                    messageId: dbId,
                    newStatus,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

    // Track delivery and read receipts
    sock.ev.on('receipt.update', async updates => {
        logger.info('Received receipt.update:', { updates });
        
        for (const update of updates) {
            if (!update.key) continue;
            
            const messageId = update.key.id;
            const { found, dbId } = await getDatabaseId(instanceId, messageId);
            
            if (!found) {
                logger.warn('Message not found for receipt update:', {
                    instanceId,
                    messageId
                });
                continue;
            }

            if (update.receipt) {
                const newStatus = update.receipt.type === 'read' ? 
                    MESSAGE_STATUS.READ : MESSAGE_STATUS.DELIVERED;
                
                await updateMessageStatusInDB(dbId, newStatus);
            }
        }
    });
};

// Export MESSAGE_STATUS for use in other files
export { MESSAGE_STATUS };
