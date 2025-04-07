// src/controllers/verify.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

export const verifyContact = async (req, res) => {
    const { email } = req.params;

    try {
        const connection = await connectDB();
        
        logger.info('Checking verification status for:', { email });
        
        // Get verification status from register table using email
        const [rows] = await connection.query(
            'SELECT verified FROM register WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
                verified: 'no'
            });
        }

        return res.json({
            success: true,
            verified: rows[0].verified === 'yes' ? 'yes' : 'no'
        });

    } catch (error) {
        logger.error('Error checking verification status:', error);
        return res.status(500).json({
            success: false,
            message: 'Error checking verification status',
            error: error.message,
            verified: 'no'
        });
    }
};

export const verifyRegistration = async (req, res) => {
    let { email } = req.params;
    
    try {
        const connection = await connectDB();
        
        logger.info('Verifying registration for email:', { email });
        
        // Get registration details and verification status
        const [rows] = await connection.query(
            `SELECT 
                r.verified,
                wr.f_name, 
                wr.l_name, 
                wr.phone, 
                wr.email, 
                wr.address,
                wr.company_name
             FROM website_registration wr
             LEFT JOIN register r ON r.email = wr.email
             WHERE wr.email = ?
             ORDER BY wr.id DESC LIMIT 1`,
            [email]
        );

        logger.info('Query result:', { rows });

        if (rows.length === 0) {
            logger.info('No registration found for email:', { email });
            return res.status(404).json({
                success: false,
                message: 'No registration found with this email. Please make sure you have completed the payment process first.'
            });
        }

        const responseData = {
            success: true,
            verified: rows[0]?.verified === 'yes' ? 'yes' : 'no',
            data: rows[0]
        };
        
        logger.info('Sending response:', { responseData });

        // Return registration details
        return res.status(200).json(responseData);

    } catch (error) {
        logger.error('Registration verification error:', {
            error: error.message,
            stack: error.stack,
            email
        });
        return res.status(500).json({
            success: false,
            message: 'Failed to verify registration'
        });
    }
};
