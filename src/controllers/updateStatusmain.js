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

    try {
        const connection = await connectDB();
        const query = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.query(query, [newStatus, messageId]);

        if (result.affectedRows > 0) {
            logger.info(`Message status updated successfully`, {
                messageId,
                newStatus,
                timestamp: new Date().toISOString()
            });
        } else {
            logger.warn(`No message found with ID ${messageId}`);
        }
    } catch (error) {
        logger.error('Failed to update message status in DB:', {
            error: error.message,
            messageId,
            newStatus
        });
        throw error;
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
                switch (update.update.status) {
                    case 'PENDING':
                    case 1:
                        newStatus = MESSAGE_STATUS.PENDING;
                        break;
                    case 3: // Delivered
                        newStatus = MESSAGE_STATUS.DELIVERED;
                        break;
                    case 4: // Read
                        newStatus = MESSAGE_STATUS.READ;
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