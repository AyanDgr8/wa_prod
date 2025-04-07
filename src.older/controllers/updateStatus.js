// src/controllers/updateStatus.js

import connectDB from '../db/index.js';

// Valid ENUM values for `message_status`
const validMessageStatus = ['sent', 'delivered', 'read', 'failed'];

// Function to update message status in the database
export const updateMessageStatusInDB = async (messageId, newStatus) => {
    // Validate `newStatus`
    const validatedStatus = validMessageStatus.includes(newStatus) ? newStatus : 'sent';

    try {
        const connection = await connectDB();

        const query = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.query(query, [validatedStatus, messageId]);

        if (result.affectedRows > 0) {
            console.log(`Message status updated successfully for message ID ${messageId} to ${validatedStatus}`);
        } else {
            console.log(`No rows updated for message ID ${messageId}. It may not exist.`);
        }

        await connection.end();
    } catch (error) {
        console.error('Failed to update message status in DB:', {
            error: error.message,
        });
    }
};

// Function to process and update message statuses
export const setUpdateMessage = async () => {
    try {
        const connection = await connectDB();

        // Fetch messages with status 'sent'
        const [rows] = await connection.query(
            `SELECT * FROM media_messages WHERE message_status = 'sent'`
        );

        for (const message of rows) {
            const instance = instances[message.instance_id];
            const instanceSock = instance && instance.sock;

            // Skip processing if the instance is not connected
            if (!instanceSock) continue;

            try {
                const jid = `${message.recipient}@s.whatsapp.net`;

                let isMediaSent = !!message.media; // Simulate media sent
                let isMessageSent = !!message.message; // Simulate message sent
                let isMessageRead = !!message.read; // Simulate message read

                // Determine the new status based on conditions
                const newStatus = isMessageRead
                    ? 'read'
                    : (isMediaSent || isMessageSent)
                    ? 'delivered'
                    : 'failed';

                // Update the message status in the database
                await updateMessageStatusInDB(message.id, newStatus);

            } catch (sendError) {
                console.error(`Error processing message ID ${message.id}:`, sendError);

                // Update status to 'failed' if something goes wrong
                await updateMessageStatusInDB(message.id, 'failed');
            }
        }

        await connection.end();
    } catch (dbError) {
        console.error('Error fetching or processing messages:', dbError);
    }
};

// Schedule the message updater to run every minute
setInterval(setUpdateMessage, 60000); // Check for updates every 1 minute
