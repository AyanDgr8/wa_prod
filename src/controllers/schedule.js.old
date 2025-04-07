// src/controllers/schedule.js

import connectDB from '../db/index.js';
import cron from 'node-cron';
import { instances, initializeSock } from './qrcode.js';
import { logger } from '../logger.js';

// Function to save scheduled message to database
export const saveScheduledMessage = async (instanceId, phoneNumbers, message, media, caption, scheduleTime) => {
    try {
        // Validate that scheduleTime is in the future
        const currentTime = new Date();
        const scheduledDateTime = new Date(scheduleTime);
        
        if (scheduledDateTime <= currentTime) {
            throw new Error('Schedule time must be in the future');
        }

        const connection = await connectDB();
        
        // Format the schedule time while preserving the local timezone
        const pad = (num) => String(num).padStart(2, '0');
        const formattedScheduleTime = `${scheduledDateTime.getFullYear()}-${pad(scheduledDateTime.getMonth() + 1)}-${pad(scheduledDateTime.getDate())} ${pad(scheduledDateTime.getHours())}:${pad(scheduledDateTime.getMinutes())}:${pad(scheduledDateTime.getSeconds())}`;
        
        // Convert phoneNumbers to array if it's not already
        const recipients = Array.isArray(phoneNumbers) ? phoneNumbers : [phoneNumbers];
        
        const query = `
            INSERT INTO media_messages 
            (instance_id, recipient, message, media, caption, schedule_time, message_status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW());
        `;

        const savedIds = [];
        
        // Save separate row for each recipient
        for (const recipient of recipients) {
            const values = [
                instanceId || null,
                recipient.trim(),  // Save single recipient
                message || null,
                media || null,
                caption || null,
                formattedScheduleTime
            ];

            logger.info('Saving scheduled message for recipient:', {
                recipient: recipient.trim(),
                scheduleTime: formattedScheduleTime
            });
            
            const [result] = await connection.execute(query, values);
            savedIds.push(result.insertId);
            logger.info('Scheduled message saved:', { recipient, messageId: result.insertId });
        }

        return savedIds;
    } catch (error) {
        logger.error('Error saving scheduled message:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to send a single message using Baileys
const sendMessage = async (sock, jid, message) => {
    try {
        logger.debug('Attempting to send message:', { jid, message });
        
        if (!sock || !sock.sendMessage) {
            logger.error('Invalid socket object:', { sock });
            return false;
        }
        
        await sock.sendMessage(jid, { text: message });
        logger.info('Message sent successfully:', { jid });
        return true;
    } catch (error) {
        logger.error('Error sending message:', { error: error.message, stack: error.stack, jid });
        return false;
    }
};

// Function to get pending scheduled messages
export const getPendingScheduledMessages = async () => {
    try {
        const connection = await connectDB();
        const query = `
            SELECT id, instance_id, recipient, message, media, caption, schedule_time, message_status, created_at FROM media_messages 
            WHERE message_status = 'pending' 
            AND schedule_time IS NOT NULL
            AND schedule_time <= NOW()
            ORDER BY schedule_time ASC
            LIMIT 10
        `;
        
        const [rows] = await connection.execute(query);
        logger.debug('Getting pending scheduled messages:', { 
            currentTime: new Date().toISOString(),
            messageCount: rows.length 
        });
        logger.debug('Found messages:', { messages: rows });
        return rows;
    } catch (error) {
        logger.error('Error getting pending scheduled messages:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Initialize scheduler
export const initializeScheduler = () => {
    logger.info('Initializing message scheduler...');
    
    // Run every minute
    const scheduler = cron.schedule('* * * * *', async () => {
        try {
            const currentTime = new Date();
            logger.debug('Scheduler running at:', currentTime.toISOString());
            
            const pendingMessages = await getPendingScheduledMessages();
            logger.debug('Found pending messages:', pendingMessages.length);
            
            // Group messages by instance_id for efficiency
            const messagesByInstance = {};
            for (const message of pendingMessages) {
                if (!messagesByInstance[message.instance_id]) {
                    messagesByInstance[message.instance_id] = [];
                }
                messagesByInstance[message.instance_id].push(message);
            }
            
            // Process messages by instance
            for (const [instanceId, messages] of Object.entries(messagesByInstance)) {
                try {
                    // Get or initialize WhatsApp instance
                    let instance = instances[instanceId];
                    logger.debug('Instance found:', !!instance, 'Instance ID:', instanceId);
                    
                    if (!instance || !instance.sock || instance.status !== 'connected') {
                        logger.info(`WhatsApp instance ${instanceId} not found or not connected. Attempting to initialize...`);
                        try {
                            await initializeSock(instanceId);
                            instance = instances[instanceId];
                            
                            // Wait for connection to be established
                            if (!instance || !instance.sock || instance.status !== 'connected') {
                                logger.info(`Could not initialize WhatsApp instance ${instanceId}. Will retry next time.`);
                                continue;
                            }
                        } catch (error) {
                            logger.error(`Error initializing WhatsApp instance ${instanceId}:`, { error: error.message, stack: error.stack });
                            continue;
                        }
                    }
                    
                    logger.info(`Processing ${messages.length} messages for instance ${instanceId}`);
                    
                    // Process all messages for this instance
                    for (const message of messages) {
                        try {
                            // Format the recipient number
                            const formattedNumber = message.recipient.replace(/[+\s-]/g, '');
                            const jid = `${formattedNumber}@s.whatsapp.net`;
                            logger.debug('Formatted JID:', jid);

                            // Send the message
                            const success = await sendMessage(instance.sock, jid, message.message);
                            
                            // Update message status
                            await updateScheduledMessageStatus(
                                message.id, 
                                success ? 'sent' : 'failed'
                            );

                            if (success) {
                                logger.info(`Successfully sent scheduled message ${message.id} to ${jid}`);
                            } else {
                                logger.error(`Failed to send scheduled message ${message.id} to ${jid}`);
                            }

                        } catch (err) {
                            logger.error(`Error processing message ${message.id}:`, { error: err.message, stack: err.stack });
                            await updateScheduledMessageStatus(message.id, 'failed');
                        }
                    }
                } catch (instanceError) {
                    logger.error(`Error processing instance ${instanceId}:`, { error: instanceError.message, stack: instanceError.stack });
                }
            }
        } catch (error) {
            logger.error('Error in scheduler:', { error: error.message, stack: error.stack });
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    scheduler.start();
    logger.info('Message scheduler initialized and running');
    return scheduler;
};

// Function to update message status
export const updateScheduledMessageStatus = async (messageId, message_status) => {
    try {
        const connection = await connectDB();
        const query = `
            UPDATE media_messages 
            SET message_status = ? 
            WHERE id = ?
        `;
        
        await connection.execute(query, [message_status, messageId]);
        logger.info(`Updated message ${messageId} status to: ${message_status}`);
    } catch (error) {
        logger.error('Error updating message status:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to save media message to database for scheduled sending
export const saveMediaMessage = async (req, res) => {
    try {
        const { instance_id, recipient, schedule_time, message } = req.body;

        if (!instance_id || !recipient || !schedule_time || !message) {
            return res.status(400).json({ error: 'instance_id, recipient, schedule_time and message are required' });
        }

        const connection = await connectDB();

        // Check if instance exists
        const [existingInstances] = await connection.query(
            "SELECT * FROM instances WHERE instance_id = ?",
            [instance_id]
        );

        if (existingInstances.length === 0) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        // Format the phone number - remove any +, spaces, or special characters
        const formattedRecipient = recipient.replace(/[+\s-]/g, '');
        
        // Validate schedule time
        const scheduleDate = new Date(schedule_time);
        if (isNaN(scheduleDate.getTime())) {
            return res.status(400).json({ error: 'Invalid schedule_time format' });
        }

        try {
            // Insert into media_messages with pending status
            const query = `
                INSERT INTO media_messages 
                (instance_id, recipient, message, schedule_time, message_status, created_at) 
                VALUES (?, ?, ?, ?, ?, NOW())
            `;
            
            logger.debug('Inserting message with values:', {
                instance_id,
                formattedRecipient,
                message,
                schedule_time,
                message_status: 'pending'
            });

            const [result] = await connection.execute(query, [
                instance_id, 
                formattedRecipient, 
                message, 
                schedule_time,
                'pending'
            ]);

            return res.status(201).json({ 
                success: true, 
                message: 'Message scheduled successfully',
                id: result.insertId,
                scheduled_time: schedule_time
            });

        } catch (dbError) {
            logger.error('Database error:', { error: dbError.message, stack: dbError.stack });
            return res.status(500).json({ 
                success: false, 
                message: 'Failed to schedule message',
                error: dbError.message 
            });
        }

    } catch (error) {
        logger.error('Error processing request:', { error: error.message, stack: error.stack });
        return res.status(500).json({ error: 'Server error' });
    }
};