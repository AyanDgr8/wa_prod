// src/controllers/subscription.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

// Helper function to check if subscription_updates table exists
const checkSubscriptionUpdatesTable = async (pool) => {
    try {
        await pool.query('SELECT 1 FROM subscription_updates LIMIT 1');
        return true;
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') {
            logger.info('Creating subscription_updates table...');
            // Create the table if it doesn't exist
            await pool.query(`
                CREATE TABLE IF NOT EXISTS subscription_updates (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    email VARCHAR(255) NOT NULL,
                    instance_id VARCHAR(255) NOT NULL,
                    package VARCHAR(50) NOT NULL,
                    date_purchased DATE NOT NULL,
                    date_expiry DATE NOT NULL,
                    bought_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_email (email),
                    INDEX idx_instance_id (instance_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            logger.info('subscription_updates table created successfully');
            return true;
        }
        throw error;
    }
};

// Initialize subscription_updates table
(async () => {
    try {
        const pool = await connectDB();
        await checkSubscriptionUpdatesTable(pool);
        logger.info('subscription_updates table check completed');
    } catch (error) {
        logger.error('Error initializing subscription_updates table:', error);
    }
})();

export const checkSubscription = async (req, res) => {
    const pool = await connectDB();
    try {
        const { id: instance_id } = req.params;
        
        // Ensure subscription_updates table exists
        await checkSubscriptionUpdatesTable(pool);
        
        // Check if subscription exists
        const [subscription] = await pool.query(
            'SELECT id FROM subscription WHERE instance_id = ? LIMIT 1',
            [instance_id]
        );

        res.json({
            success: true,
            hasSubscription: subscription && subscription.length > 0
        });

    } catch (error) {
        logger.error('Error in checkSubscription:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

export const getSubscriptionDetails = async (req, res) => {
    const pool = await connectDB();
    try {
        const { id: instance_id } = req.params;
        
        // Ensure subscription_updates table exists
        await checkSubscriptionUpdatesTable(pool);
        
        // Get current subscription details - get the latest subscription entry
        const [currentSubscription] = await pool.query(
            'WITH latest_sub AS ( ' +
            '    SELECT * FROM subscription ' +
            '    WHERE instance_id = ? ' +
            '    AND date_expiry >= CURDATE() ' +
            '    ORDER BY created_at DESC, id DESC ' +
            '    LIMIT 1 ' +
            '), ' +
            'prev_sub AS ( ' +
            '    SELECT created_at as prev_start, date_expiry as prev_end ' +
            '    FROM subscription ' +
            '    WHERE instance_id = ? ' +
            '    AND created_at < (SELECT created_at FROM latest_sub) ' +
            '    ORDER BY created_at DESC ' +
            '    LIMIT 1 ' +
            ') ' +
            'SELECT ' +
            'ls.*, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at) as messages_sent, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at ' +
            'AND message_status != "failed") as successful_messages, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at ' +
            'AND message_status = "failed") as failed_messages, ' +
            'DATEDIFF(ls.date_expiry, CURDATE()) as days_remaining ' +
            'FROM latest_sub ls ' +
            'LEFT JOIN prev_sub ps ON 1=1',
            [instance_id, instance_id]
        );

        // Get all-time stats with sum of all purchased messages and package counts from subscription_updates
        const [allTimeStats] = await pool.query(
            'SELECT ' +
            '(SELECT SUM(num_messages) FROM subscription WHERE instance_id = ?) as total_messages_purchased, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ?) as total_messages_sent, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ? AND message_status = "failed") as total_failed_messages, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ? AND message_status != "failed") as total_successful_messages, ' +
            '(SELECT COUNT(*) FROM subscription_updates WHERE instance_id = ?) as total_packages_bought ' +
            'FROM dual',
            [instance_id, instance_id, instance_id, instance_id, instance_id]
        );

        // Get package statistics from subscription_updates table
        const [packageStats] = await pool.query(
            'SELECT package, COUNT(*) as count FROM subscription_updates ' +
            'WHERE instance_id = ? ' +
            'GROUP BY package',
            [instance_id]
        );

        // Create a map of package counts
        const packageCounts = {
            "Trial": 0,
            "Neo": 0,
            "Starter": 0,
            "Pro": 0,
            "Pro Max": 0,
            "Enterprise": 0
        };

        // Fill in the actual counts from the database
        packageStats.forEach(stat => {
            if (packageCounts.hasOwnProperty(stat.package)) {
                packageCounts[stat.package] = parseInt(stat.count);
            }
        });

        if (!currentSubscription || currentSubscription.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No subscription found for this instance' 
            });
        }

        const subscriptionData = currentSubscription[0];
        const allTimeData = allTimeStats[0];

        // Current subscription stats
        const messages_sent = parseInt(subscriptionData.messages_sent) || 0;
        const failed_messages = parseInt(subscriptionData.failed_messages) || 0;
        const successful_messages = parseInt(subscriptionData.successful_messages) || 0;
        const messages_remaining = Math.max(0, subscriptionData.num_messages - messages_sent);
        const days_remaining = parseInt(subscriptionData.days_remaining) || 0;

        // All-time stats
        const total_messages_sent = parseInt(allTimeData.total_messages_sent) || 0;
        const total_failed_messages = parseInt(allTimeData.total_failed_messages) || 0;
        const total_successful_messages = parseInt(allTimeData.total_successful_messages) || 0;
        const total_messages_purchased = parseInt(allTimeData.total_messages_purchased) || 0;
        const total_packages_bought = parseInt(allTimeData.total_packages_bought) || 0;

        // Check if the subscription is expired
        const isExpired = new Date(subscriptionData.date_expiry) < new Date();

        res.json({
            success: true,
            data: {
                current: {
                    ...subscriptionData,
                    messages_sent,
                    failed_messages,
                    successful_messages,
                    messages_remaining,
                    total_messages: subscriptionData.num_messages,
                    is_expired: isExpired,
                    days_remaining
                },
                allTime: {
                    messages_sent: total_messages_sent,
                    failed_messages: total_failed_messages,
                    successful_messages: total_successful_messages,
                    total_messages: total_messages_purchased,
                    total_packages_bought,
                    packageCounts
                },
                packageStats: packageCounts
            }
        });

    } catch (error) {
        logger.error('Error in getSubscriptionDetails:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

// Renew subscription
export const renewSubscription = async (req, res) => {
    const pool = await connectDB();
    try {
        const { id: instance_id } = req.params;
        const { package: packageName, amount } = req.body;

        if (!packageName || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Package name and amount are required'
            });
        }

        await pool.beginTransaction();

        // Ensure subscription_updates table exists
        await checkSubscriptionUpdatesTable(pool);

        // Get user details from instance and register tables
        const [instance] = await pool.query(
            'SELECT r.id as register_id, r.email, r.telephone as phone, r.username, r.address, r.company_name ' +
            'FROM instances i ' +
            'JOIN register r ON i.register_id = r.id ' +
            'WHERE i.id = ?',
            [instance_id]
        );

        if (!instance.length) {
            await pool.rollback();
            return res.status(404).json({
                success: false,
                message: 'Instance not found'
            });
        }

        const userDetails = instance[0];

        // Split username into first and last name for website_registration
        const [firstName, ...lastNameParts] = userDetails.username.split(' ');
        const lastName = lastNameParts.join(' ');

        // Insert into website_registration first to trigger after_website_registration_insert
        await pool.query(
            `INSERT INTO website_registration (
                f_name, l_name, phone, email, package_purchased,
                date_of_purchase, amount_paid, address, company_name,
                is_renewal
            ) VALUES (?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, 1)`,
            [
                firstName,
                lastName,
                userDetails.phone,
                userDetails.email,
                packageName,
                parseFloat(amount),
                userDetails.address || '',
                userDetails.company_name || null
            ]
        );

        // Get current subscription if exists
        const [currentSubscription] = await pool.query(
            'SELECT * FROM subscription WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1',
            [instance_id]
        );

        // Calculate package details based on package name
        let validity = 30; // Default validity
        let numMessages = 0;

        switch (packageName) {
            case 'Trial':
                validity = 7;
                numMessages = 100;
                break;
            case 'Neo':
                validity = 30;
                numMessages = 1000;
                break;
            case 'Starter':
                validity = 30;
                numMessages = 5000;
                break;
            case 'Pro':
                validity = 30;
                numMessages = 15000;
                break;
            case 'Pro Max':
                validity = 30;
                numMessages = 50000;
                break;
            case 'Enterprise':
                validity = 30;
                numMessages = 150000;
                break;
            default:
                await pool.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Invalid package name'
                });
        }

        // Add remaining messages from current subscription if it exists
        if (currentSubscription.length > 0) {
            numMessages += currentSubscription[0].num_messages;
        }

        // Calculate dates
        const startDate = new Date();
        const expiryDate = new Date();
        expiryDate.setDate(startDate.getDate() + validity);

        // Insert into subscription table
        const [subscriptionResult] = await pool.query(
            'INSERT INTO subscription (instance_id, package, amount, num_messages, date_purchased, date_expiry) VALUES (?, ?, ?, ?, ?, ?)',
            [instance_id, packageName, amount, numMessages, startDate, expiryDate]
        );

        // Insert into subscription_updates table
        await pool.query(
            'INSERT INTO subscription_updates (email, instance_id, package, date_purchased, date_expiry) VALUES (?, ?, ?, ?, ?)',
            [userDetails.email, instance_id, packageName, startDate, expiryDate]
        );

        await pool.commit();

        res.json({
            success: true,
            message: 'Subscription renewed successfully',
            data: {
                subscription_id: subscriptionResult.insertId,
                package: packageName,
                validity,
                num_messages: numMessages,
                start_date: startDate,
                expiry_date: expiryDate
            }
        });

    } catch (error) {
        if (pool) {
            await pool.rollback();
        }
        logger.error('Error in renewSubscription:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

// Add new subscription
export const addSubscription = async (req, res) => {
    const pool = await connectDB();
    try {
        const { instance_id, package: packageName, amount } = req.body;

        if (!instance_id || !packageName || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Instance ID, package name, and amount are required'
            });
        }

        await pool.beginTransaction();

        // Ensure subscription_updates table exists
        await checkSubscriptionUpdatesTable(pool);

        // Get user details
        const [instance] = await pool.query(
            'SELECT r.id as register_id, r.email, r.telephone as phone, r.username ' +
            'FROM instances i ' +
            'JOIN register r ON i.register_id = r.id ' +
            'WHERE i.id = ?',
            [instance_id]
        );

        if (!instance.length) {
            await pool.rollback();
            return res.status(404).json({
                success: false,
                message: 'Instance not found'
            });
        }

        const userDetails = instance[0];

        // Split username into first and last name for website_registration
        const [firstName, ...lastNameParts] = userDetails.username.split(' ');
        const lastName = lastNameParts.join(' ');

        // Insert into website_registration first to trigger after_website_registration_insert
        await pool.query(
            `INSERT INTO website_registration (
                f_name, l_name, phone, email, package_purchased,
                date_of_purchase, amount_paid, is_renewal
            ) VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 0)`,
            [
                firstName,
                lastName,
                userDetails.phone,
                userDetails.email,
                packageName,
                parseFloat(amount)
            ]
        );

        // Calculate package details
        let validity = 30;
        let numMessages = 0;

        switch (packageName) {
            case 'Trial':
                validity = 7;
                numMessages = 100;
                break;
            case 'Neo':
                validity = 30;
                numMessages = 1000;
                break;
            case 'Starter':
                validity = 30;
                numMessages = 5000;
                break;
            case 'Pro':
                validity = 30;
                numMessages = 15000;
                break;
            case 'Pro Max':
                validity = 30;
                numMessages = 50000;
                break;
            case 'Enterprise':
                validity = 30;
                numMessages = 150000;
                break;
            default:
                await pool.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Invalid package name'
                });
        }

        const startDate = new Date();
        const expiryDate = new Date();
        expiryDate.setDate(startDate.getDate() + validity);

        // Insert into subscription table
        const [subscriptionResult] = await pool.query(
            'INSERT INTO subscription (instance_id, package, amount, num_messages, date_purchased, date_expiry) VALUES (?, ?, ?, ?, ?, ?)',
            [instance_id, packageName, amount, numMessages, startDate, expiryDate]
        );

        // Insert into subscription_updates table
        await pool.query(
            'INSERT INTO subscription_updates (email, instance_id, package, date_purchased, date_expiry) VALUES (?, ?, ?, ?, ?)',
            [userDetails.email, instance_id, packageName, startDate, expiryDate]
        );

        await pool.commit();

        res.json({
            success: true,
            message: 'Subscription added successfully',
            data: {
                subscription_id: subscriptionResult.insertId,
                package: packageName,
                validity,
                num_messages: numMessages,
                start_date: startDate,
                expiry_date: expiryDate
            }
        });

    } catch (error) {
        if (pool) {
            await pool.rollback();
        }
        logger.error('Error in addSubscription:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
};
