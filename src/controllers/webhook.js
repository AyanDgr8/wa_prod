// src/controllers/webhook.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Process payment webhook and save registration data
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

export const handleWebhook = async (req, res) => {
    const pool = await connectDB();
    let connection;
    
    try {
        connection = await pool.getConnection();
        const { data } = req.body;
        
        // Extract relevant information from payload
        const {
            contact,
            plan_title,
            plan_price,
            plan_start_date,
            plan_order_id,
            site_name
        } = data;

        // Extract user information
        const {
            name: { first: firstName, last: lastName },
            email,
            phones,
            company,
            address: { addressLine }
        } = contact;

        // Get phone and country code from phones array
        const primaryPhone = phones.find(p => p.primary) || phones[0];
        const countryCode = primaryPhone.countryCode;
        const phoneId = primaryPhone.id;
        
        // Normalize phone number
        let phone = primaryPhone.formattedPhone.replace(/[\s\-()]/g, '');
        if (!phone.startsWith('+')) {
            phone = phone.startsWith('91') ? `+${phone}` : `+91${phone}`;
        }

        // Log the incoming webhook data
        logger.info('Received payment webhook:', { 
            orderId: plan_order_id,
            email,
            phone,
            amount: plan_price.value,
            package: plan_title,
            siteName: site_name
        });

        await connection.beginTransaction();

        // Check if user exists in register table by email or phone
        const [existingUser] = await connection.query(
            'SELECT id, email, telephone FROM register WHERE email = ? OR telephone = ? LIMIT 1',
            [email, phone]
        );

        let isRenewal = false;
        let registerId;

        if (existingUser.length > 0) {
            // User exists - this is a renewal
            isRenewal = true;
            registerId = existingUser[0].id;

            // Insert into website_registration with is_renewal flag
            await connection.query(
                `INSERT INTO website_registration (
                    f_name, l_name, phone, email, package_purchased,
                    date_of_purchase, amount_paid, address, company_name,
                    is_renewal, card_type
                ) VALUES (?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, 1, ?)`,
                [
                    firstName,
                    lastName,
                    phone,
                    email,
                    plan_title,
                    parseFloat(plan_price.value),
                    addressLine || '',
                    company || null,
                    countryCode === 'IN' ? 'Aadhar' : 'Passport'
                ]
            );
        } else {
            // New user - insert into website_registration first
            await connection.query(
                `INSERT INTO website_registration (
                    f_name, l_name, phone, email, package_purchased,
                    date_of_purchase, amount_paid, address, company_name,
                    is_renewal, card_type
                ) VALUES (?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, 0, ?)`,
                [
                    firstName,
                    lastName,
                    phone,
                    email,
                    plan_title,
                    parseFloat(plan_price.value),
                    addressLine || '',
                    company || null,
                    countryCode === 'IN' ? 'Aadhar' : 'Passport'
                ]
            );
        }

        // Calculate messages based on package
        const getMessages = (pkg) => {
            switch(pkg) {
                case 'Trial': return 500;
                case 'Neo': return 1000;
                case 'Starter': return 5000;
                case 'Pro': return 10000;
                case 'Pro Max': return 100000;
                case 'Enterprise': return 500000;
                default: return 0;
            }
        };

        // Calculate expiry date based on package
        const getExpiryDate = () => {
            const date = new Date();
            switch(plan_title) {
                case 'Trial':
                    date.setDate(date.getDate() + 7);
                    break;
                case 'Pro Max':
                case 'Enterprise':
                    date.setDate(date.getDate() + 90);
                    break;
                default:
                    date.setDate(date.getDate() + 30);
            }
            return date.toISOString().split('T')[0];
        };

        // Get remaining messages from current subscription if renewal
        let totalMessages = getMessages(plan_title);
        if (isRenewal) {
            const [currentSub] = await connection.query(
                'SELECT num_messages FROM subscription WHERE email = ? AND date_expiry > NOW() ORDER BY date_expiry DESC LIMIT 1',
                [email]
            );
            if (currentSub.length > 0) {
                totalMessages += currentSub[0].num_messages;
            }
        }

        // Update or insert subscription
        if (isRenewal) {
            const [existingSub] = await connection.query(
                'SELECT id, instance_id FROM subscription WHERE email = ? AND date_expiry > NOW()',
                [email]
            );

            if (existingSub.length > 0) {
                // Update existing subscription
                await connection.query(
                    `UPDATE subscription SET 
                        package = ?,
                        num_messages = ?,
                        date_purchased = CURDATE(),
                        date_expiry = ?
                    WHERE email = ? AND date_expiry > NOW()`,
                    [
                        plan_title,
                        totalMessages,
                        getExpiryDate(),
                        email
                    ]
                );

                // Insert into subscription_updates table
                await connection.query(
                    'INSERT INTO subscription_updates (email, instance_id, package, date_purchased, date_expiry) VALUES (?, ?, ?, CURDATE(), ?)',
                    [email, existingSub[0].instance_id, plan_title, getExpiryDate()]
                );
            }
        }

        // Generate registration token
        const registrationData = {
            firstName,
            lastName,
            email,
            phone,
            phoneId,
            countryCode
        };

        const token = jwt.sign(registrationData, JWT_SECRET, { expiresIn: '24h' });
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const redirectLink = isRenewal 
            ? `${baseUrl}/login?token=${token}` 
            : `${baseUrl}/register?token=${token}`;

        await connection.commit();

        // Log successful subscription renewal
        logger.info('Subscription processed', {
            email,
            isRenewal,
            package: plan_title,
            totalMessages,
            timestamp: new Date().toISOString(),
            redirectLink
        });

        res.json({
            success: true,
            message: isRenewal ? 'Subscription renewed successfully' : 'Registration successful',
            redirectLink,
            isIndian: countryCode === 'IN',
            isRenewal
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        logger.error('Error in handleWebhook:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};
