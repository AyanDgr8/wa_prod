// src/controllers/verify.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

export const verifyRegistration = async (req, res) => {
    const { phone } = req.params;
    
    try {
        const connection = await connectDB();
        
        logger.info('Verifying registration for phone:', { phone });
        
        // Get registration details by phone number
        const [rows] = await connection.query(
            `SELECT 
                f_name, 
                l_name, 
                phone, 
                email, 
                address,
                company_name
             FROM website_registration 
             WHERE phone = ?
             ORDER BY id DESC LIMIT 1`,
            [phone]
        );

        logger.info('Query result:', { rows });

        if (rows.length === 0) {
            logger.info('No registration found for phone:', { phone });
            return res.status(404).json({
                success: false,
                message: 'No registration found with this phone number. Please make sure you have completed the payment process first.'
            });
        }

        const responseData = {
            success: true,
            data: rows[0]
        };
        
        logger.info('Sending response:', { responseData });

        // Return registration details
        return res.status(200).json(responseData);

    } catch (error) {
        logger.error('Registration verification error:', {
            error: error.message,
            stack: error.stack,
            phone
        });
        return res.status(500).json({
            success: false,
            message: 'Failed to verify registration'
        });
    }
};