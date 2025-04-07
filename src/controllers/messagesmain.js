// src/controllers/messages.js

import connectDB from '../db/index.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// Function to format the scheduled time
const formatScheduledAt = (scheduledAt) => {
    if (!scheduledAt) return null;

    const date = new Date(scheduledAt);
    if (isNaN(date.getTime())) {
        logger.error('Invalid date provided:', scheduledAt);
        return null;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
};

// Function to save messaging data to the database
export const logMediaMessageToDB = async (instanceId, phoneNumbers, message, media, caption, scheduleTime, messageStatus, whatsappMessageId) => {
    try {
        const connection = await connectDB();

        // Define valid ENUM values for message_status
        const validMessageStatus = ['sent', 'delivered', 'read', 'failed', 'pending'];
        const messageStatusValidated = validMessageStatus.includes(messageStatus) ? messageStatus : 'sent';

        const query = `
            INSERT INTO media_messages 
            (instance_id, recipient, message, media, caption, schedule_time, message_status, whatsapp_message_id, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW());
        `;

        const values = [
            instanceId || null,
            Array.isArray(phoneNumbers) ? phoneNumbers.join(',') : '',
            message || null,
            media || null,
            caption || null,
            formatScheduledAt(scheduleTime),
            messageStatusValidated,
            whatsappMessageId || null
        ];

        logger.info('Logging to DB:', { values });
        const [result] = await connection.execute(query, values);
        logger.info('Message logged successfully:', { result });
        return result.insertId;

    } catch (error) {
        logger.error('Failed to log message to DB:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to update message status
export const updateMessageStatusInDB = async (messageId, newStatus) => {
    try {
        const connection = await connectDB();
        const validMessageStatus = ['sent', 'delivered', 'read', 'failed', 'pending'];
        
        if (!validMessageStatus.includes(newStatus)) {
            throw new Error(`Invalid message status: ${newStatus}`);
        }

        const query = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.execute(query, [newStatus, messageId]);

        if (result.affectedRows > 0) {
            logger.info(`Message status updated successfully for message ID ${messageId} to ${newStatus}`);
        } else {
            logger.warn(`No rows updated for message ID ${messageId}. It may not exist.`);
        }
    } catch (error) {
        logger.error('Failed to update message status in DB:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to send messages
export const sendMessagesOneAtATime = async (messages, mediaPayload, sock, instanceId, filePath, scheduleTime) => {
    let totalMessagesSent = 0;
    const totalNumbers = messages.length;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 3000; // 3 seconds

    // Check if WhatsApp is connected
    if (!sock || !sock.user || !sock.user.id) {
        logger.error('WhatsApp connection not ready');
        throw new Error('WhatsApp connection not ready');
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const getRandomDelay = () => {
        // Random delay between 2 to 6.5 seconds
        return Math.floor(Math.random() * (6500 - 2000)) + 2000;
    };

    const sendWithRetry = async (jid, messageContent, retryCount = 0) => {
        try {
            const result = await sock.sendMessage(jid, messageContent);
            return { success: true, result };
        } catch (error) {
            if (retryCount < MAX_RETRIES && error.message === 'Timed Out') {
                logger.info(`Retry attempt ${retryCount + 1} for ${jid}`);
                await sleep(RETRY_DELAY);
                return sendWithRetry(jid, messageContent, retryCount + 1);
            }
            throw error;
        }
    };

    for (const message of messages) {
        const jid = `${message.number}@s.whatsapp.net`;

        try {
            let isMediaSent = false;
            let isMessageSent = false;
            let whatsappMessageId = null;

            // First store the message as pending
            const dbMessageId = await logMediaMessageToDB(
                instanceId,
                [message.number],
                message.text || null,
                mediaPayload ? filePath : null,
                mediaPayload ? message.caption : null,
                scheduleTime,
                'pending',
                null // whatsapp_message_id will be updated after sending
            );

            // Send media with caption if mediaPayload exists
            if (mediaPayload) {
                logger.info(`Attempting to send media to ${message.number}`, { 
                    fileType: mediaPayload.mimetype || 'document',
                    fileName: mediaPayload.fileName || 'unknown'
                });
                
                try {
                    const mediaResult = await sendWithRetry(jid, {
                        ...mediaPayload,
                        caption: message.caption || '',
                        quoted: null
                    });
                    isMediaSent = true;
                    whatsappMessageId = mediaResult.result.key.id;
                    logger.info(`Media sent successfully to ${message.number}`);
                } catch (mediaError) {
                    logger.error(`Failed to send media to ${message.number}:`, { 
                        error: mediaError.message,
                        stack: mediaError.stack 
                    });
                    // Update message status to failed
                    await updateMessageStatusInDB(dbMessageId, 'failed');
                    throw mediaError;
                }
            }

            // Send text message if it exists
            if (message.text) {
                try {
                    const textResult = await sendWithRetry(jid, { 
                        text: message.text,
                        quoted: null
                    });
                    isMessageSent = true;
                    whatsappMessageId = textResult.result.key.id;
                    logger.info(`Text message sent successfully to ${message.number}`);
                } catch (textError) {
                    logger.error(`Failed to send text to ${message.number}:`, { 
                        error: textError.message,
                        stack: textError.stack 
                    });
                    // Update message status to failed
                    await updateMessageStatusInDB(dbMessageId, 'failed');
                    throw textError;
                }
            }

            // Add a random delay between messages to prevent detection
            const randomDelay = getRandomDelay();
            logger.info(`Waiting ${randomDelay/1000} seconds before next message...`);
            await sleep(randomDelay);

            // Update the message with WhatsApp message ID and status
            await updateMessageWithWhatsAppId(dbMessageId, whatsappMessageId);

            totalMessagesSent++;
            logger.info(`Progress: ${totalMessagesSent}/${totalNumbers} messages sent`);

        } catch (err) {
            logger.error(`Failed to send message to ${message.number}:`, { 
                error: err.message,
                stack: err.stack,
                mediaPayload: mediaPayload ? {
                    type: mediaPayload.mimetype || 'document',
                    fileName: mediaPayload.fileName
                } : null
            });
            continue;
        }
    }

    return totalMessagesSent;
};

// Send text message and return the message ID
export const sendTextMessage = async (sock, recipient, message) => {
    try {
        const msg = await sock.sendMessage(recipient + "@s.whatsapp.net", {
            text: message
        });
        return msg.key.id; // Return the WhatsApp message ID
    } catch (error) {
        logger.error('Failed to send text message:', error);
        throw error;
    }
};

// Update message with WhatsApp ID
export const updateMessageWithWhatsAppId = async (dbId, whatsappMessageId) => {
    try {
        const connection = await connectDB();
        const query = `UPDATE media_messages SET whatsapp_message_id = ?, message_status = 'sent' WHERE id = ?`;
        const [result] = await connection.query(query, [whatsappMessageId, dbId]);
        
        logger.info('Message updated with WhatsApp ID:', { dbId, whatsappMessageId });
        return result;
    } catch (error) {
        logger.error('Failed to update message with WhatsApp ID:', error);
        throw error;
    }
};

// Send messages function
export const sendMessages = async (req, res) => {
    try {
        const { instanceId, messages } = req.body;
        const sock = getSocketConnection(instanceId);
        
        if (!sock) {
            return res.status(400).json({ error: 'Instance not found' });
        }

        let progress = 0;
        const total = messages.length;

        for (const messageData of messages) {
            let dbId;
            try {
                // First log to DB with pending status
                dbId = await logMediaMessageToDB(
                    instanceId,
                    [messageData.recipient],
                    messageData.message,
                    null, // media
                    null, // caption
                    messageData.schedule_time,
                    'pending',
                    null // whatsapp_message_id will be updated after sending
                );

                // Send message and get WhatsApp message ID
                const whatsappMessageId = await sendTextMessage(sock, messageData.recipient, messageData.message);
                
                // Update DB record with WhatsApp message ID and status
                await updateMessageWithWhatsAppId(dbId, whatsappMessageId);

                progress++;
                logger.info(`Progress: ${progress}/${total} messages sent`);

                // Add delay between messages
                if (progress < total) {
                    const delay = Math.random() * 4000 + 2000; // 2-6 seconds
                    logger.info(`Waiting ${(delay/1000).toFixed(3)} seconds before next message...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                logger.error('Failed to send message:', error);
                // Update status to failed if we have a dbId
                if (dbId) {
                    await updateMessageStatusInDB(dbId, 'failed');
                }
            }
        }

        res.json({ success: true, message: `${progress}/${total} messages sent successfully` });
    } catch (error) {
        logger.error('Error in sendMessages:', error);
        res.status(500).json({ error: error.message });
    }
};

// Handle media message sending
export const sendMedia = async (req, res) => {
    const { instanceId, sock } = req;
    const { messages, filePath, scheduleTime } = req.body;

    try {
        // Validate required fields
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Messages are required and must be an array' 
            });
        }

        // Get latest subscription details
        const connection = await connectDB();
        const [subscriptionDetails] = await connection.query(
            'SELECT s.* FROM subscription s ' +
            'WHERE s.instance_id = ? ' +
            'AND s.date_expiry >= CURDATE() ' +  // Only get active subscription
            'ORDER BY s.created_at DESC, s.id DESC ' +  // Order by created_at and id to get the newest
            'LIMIT 1',
            [instanceId]
        );

        if (!subscriptionDetails || subscriptionDetails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No active subscription found'
            });
        }

        const subscription = subscriptionDetails[0];
        logger.info('Current Subscription:', { subscription });

        // Get count of messages sent in current subscription period
        const [messageCount] = await connection.query(
            'SELECT COUNT(*) as count FROM media_messages ' +
            'WHERE instance_id = ? ' +
            'AND created_at >= ? ' +
            'AND created_at <= COALESCE(?, NOW()) ' +  // Only count messages within subscription period
            'AND created_at >= (SELECT created_at FROM subscription ' +  // Only count messages after this subscription was created
            '                  WHERE instance_id = ? ' +
            '                  AND id = ?)',
            [instanceId, subscription.date_purchased, subscription.date_expiry, instanceId, subscription.id]
        );

        const totalMessagesSent = messageCount[0].count;
        const messagesRemaining = subscription.num_messages - totalMessagesSent;

        logger.info('Message Stats:', {
            totalMessages: subscription.num_messages,
            totalSent: totalMessagesSent,
            remaining: messagesRemaining,
            subscriptionId: subscription.id,
            datePurchased: subscription.date_purchased,
            dateExpiry: subscription.date_expiry,
            createdAt: subscription.created_at
        });

        if (messagesRemaining <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Message limit reached. Please recharge your subscription.'
            });
        }

        // Check if total numbers to send exceeds remaining messages
        if (messages.length > messagesRemaining) {
            return res.status(400).json({
                success: false,
                message: `Can only send ${messagesRemaining} more messages with current subscription`
            });
        }

        if (!sock) {
            return res.status(400).json({ 
                success: false,
                message: 'WhatsApp instance not connected' 
            });
        }

        let mediaPayload = null;
        let fileExtension = null;

        // Process media file if provided
        if (filePath) {
            try {
                // Check if file exists
                if (!fs.existsSync(filePath)) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'File not found' 
                    });
                }

                // Check file size (16MB limit)
                const stats = fs.statSync(filePath);
                const fileSizeInMB = stats.size / (1024 * 1024);
                if (fileSizeInMB > 16) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'File size exceeds 16MB limit' 
                    });
                }

                fileExtension = path.extname(filePath).toLowerCase();
                const fileBuffer = await fs.promises.readFile(filePath);
                const mimeTypes = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.mp4': 'video/mp4',
                    '.mov': 'video/quicktime',
                    '.mp3': 'audio/mpeg',
                    '.wav': 'audio/wav',
                    '.ogg': 'audio/ogg',
                    '.pdf': 'application/pdf',
                    '.doc': 'application/msword',
                    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                };

                switch (fileExtension) {
                    case '.jpg':
                    case '.jpeg':
                    case '.png':
                        mediaPayload = {
                            image: fileBuffer,
                            caption: messages[0].caption || '',
                            mimetype: mimeTypes[fileExtension]
                        };
                        break;
                    case '.mp4':
                    case '.mov':
                        mediaPayload = {
                            video: fileBuffer,
                            caption: messages[0].caption || '',
                            mimetype: mimeTypes[fileExtension]
                        };
                        break;
                    case '.mp3':
                    case '.wav':
                    case '.ogg':
                        mediaPayload = {
                            audio: fileBuffer,
                            mimetype: mimeTypes[fileExtension],
                            ptt: fileExtension === '.ogg',
                            caption: messages[0].caption || ''
                        };
                        break;
                    case '.pdf':
                    case '.doc':
                    case '.docx':
                        mediaPayload = {
                            document: fileBuffer,
                            mimetype: mimeTypes[fileExtension],
                            fileName: path.basename(filePath),
                            caption: messages[0].caption || ''
                        };
                        break;
                    default:
                        // For Excel and other files, send as document with auto-detected mimetype
                        mediaPayload = {
                            document: fileBuffer,
                            fileName: path.basename(filePath),
                            caption: messages[0].caption || '',
                            mimetype: 'application/octet-stream'  // Generic binary file type
                        };
                }

                // Log the media payload for debugging
                logger.info('Media payload created:', {
                    type: fileExtension,
                    fileName: path.basename(filePath),
                    size: fileBuffer.length,
                    mimeType: mediaPayload.mimetype || 'application/octet-stream'
                });
            } catch (error) {
                logger.error('Media processing error:', { error: error.message });
                return res.status(400).json({ 
                    success: false,
                    message: error.message || 'Invalid or missing media file' 
                });
            }
        }

        // Send messages with logging
        const totalSent = await sendMessagesOneAtATime(
            messages,
            mediaPayload,
            sock,
            instanceId,
            filePath,
            scheduleTime
        );

        // Return success response
        res.json({
            success: true,
            message: `Successfully processed ${totalSent} messages`,
            totalMessages: totalSent
        });

    } catch (error) {
        logger.error('Error in sendMedia:', { error: error.message, stack: error.stack });
        
        // Log the error message to database
        try {
            if (messages && instanceId) {
                await logMediaMessageToDB(
                    instanceId,
                    messages.map(message => message.number),
                    messages[0].text,
                    filePath,
                    messages[0].caption,
                    scheduleTime,
                    'failed',
                    null
                );
            }
        } catch (dbError) {
            logger.error('Error logging to database:', { error: dbError.message, stack: dbError.stack });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to send messages',
            error: error.message
        });
    }
};