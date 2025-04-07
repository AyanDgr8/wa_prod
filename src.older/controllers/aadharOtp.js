// src/controllers/aadharOtp.js

import { logger } from '../logger.js';
import axios from 'axios';
import mysql from 'mysql2/promise';
import { DB_NAME } from '../constants.js';

const SUREPASS_API_URL = process.env.SUREPASS_API_URL;
const SUREPASS_TOKEN = process.env.SUREPASS_TOKEN;

// Store client_id and user data for verification
const otpStorage = new Map();

// Create a single connection pool
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: DB_NAME,
    port: process.env.MYSQL_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Send OTP to Aadhar-linked mobile number using Surepass API
export const sendAadharOTP = async (req, res) => {
    try {
        const { aadharNumber } = req.body;
        logger.info(`Received OTP request for Aadhar: ${aadharNumber}`);

        // Validate Aadhar number
        if (!aadharNumber || !/^\d{12}$/.test(aadharNumber)) {
            logger.warn(`Invalid Aadhar number format: ${aadharNumber}`);
            return res.status(400).json({ 
                success: false,
                message: 'Invalid Aadhar number format. Must be 12 digits.' 
            });
        }

        // Check if OTP was recently sent
        const existingOTP = otpStorage.get(aadharNumber);
        if (existingOTP && (Date.now() - existingOTP.timestamp) < 60000) {
            logger.warn(`OTP request too frequent for Aadhar: ${aadharNumber}`);
            return res.status(429).json({
                success: false,
                message: 'Please wait 1 minute before requesting another OTP'
            });
        }

        logger.info(`Calling Surepass API for OTP generation: ${aadharNumber}`);
        
        // Call Surepass API to generate OTP
        const response = await axios.post(
            `${SUREPASS_API_URL}/generate-otp`,
            { id_number: aadharNumber },
            {
                headers: {
                    'Authorization': `Bearer ${SUREPASS_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.data?.success || !response.data?.data?.client_id) {
            logger.error('Invalid response from Surepass API:', response.data);
            throw new Error('Invalid response from Surepass API');
        }

        // Store OTP data with timestamp
        otpStorage.set(aadharNumber, {
            client_id: response.data.data.client_id,
            timestamp: Date.now()
        });

        logger.info(`OTP sent successfully for Aadhar: ${aadharNumber}`);
        res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            client_id: response.data.data.client_id
        });

    } catch (error) {
        logger.error('Error in sendAadharOTP:', {
            error: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
        
        const errorMessage = error.response?.data?.message || 
                           error.response?.data?.error || 
                           error.message || 
                           'Failed to send OTP';
                           
        res.status(error.response?.status || 500).json({ 
            success: false,
            message: errorMessage,
            error: error.response?.data || error.message
        });
    }
};

// Update verification status in register table
const updateVerificationStatus = async (email) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Update verified status in register table
        const [updateResult] = await connection.execute(
            `UPDATE register SET verified = 'yes' WHERE email = ?`,
            [email]
        );

        if (updateResult.affectedRows === 0) {
            logger.warn(`No user found with email: ${email}`);
            throw new Error('User not found');
        }

        logger.info(`Verification status updated for user: ${email}`);
        return true;
    } catch (error) {
        logger.error('Error in updateVerificationStatus:', {
            error: error.message,
            email: email
        });
        throw {
            status: error.message === 'User not found' ? 404 : 500,
            message: error.message === 'User not found' ? 
                'User not found in database' : 
                'Failed to update verification status'
        };
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

// Verify OTP and match name using Surepass API
export const verifyAadharOTP = async (req, res) => {
    try {
        const { aadharNumber, otp, email } = req.body;
        logger.info(`Verifying OTP for Aadhar: ${aadharNumber}`);

        // Validate required fields
        if (!aadharNumber || !otp || !email) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: aadharNumber, otp, or email'
            });
        }

        const storedData = otpStorage.get(aadharNumber);
        if (!storedData) {
            return res.status(400).json({
                success: false,
                message: 'Please generate OTP first'
            });
        }

        // Check if OTP has expired (10 minutes)
        if (Date.now() - storedData.timestamp > 600000) {
            otpStorage.delete(aadharNumber);
            return res.status(400).json({
                success: false,
                message: 'OTP has expired. Please generate a new one.',
                error_type: 'OTP_EXPIRED'
            });
        }

        // Verify OTP with Surepass
        const response = await axios.post(
            `${SUREPASS_API_URL}/submit-otp`,
            {
                client_id: storedData.client_id,
                otp: otp
            },
            {
                headers: {
                    'Authorization': `Bearer ${SUREPASS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            try {
                // Update verification status
                await updateVerificationStatus(email);
                
                // Clear OTP data
                otpStorage.delete(aadharNumber);

                return res.status(200).json({
                    success: true,
                    message: 'OTP verified successfully',
                    data: {
                        verified: true,
                        name: response.data.data.full_name
                    }
                });
            } catch (dbError) {
                logger.error('Database error after successful OTP verification:', dbError);
                return res.status(dbError.status || 500).json({
                    success: false,
                    message: dbError.message || 'Failed to update verification status',
                    verified: true // OTP was verified but DB update failed
                });
            }
        } else {
            return res.status(400).json({ 
                success: false,
                message: 'OTP verification failed',
                error_type: 'OTP_MISMATCH'
            });
        }
    } catch (error) {
        logger.error('Error in verifyAadharOTP:', {
            error: error.message,
            response: error.response?.data
        });
        
        return res.status(error.response?.status || 500).json({
            success: false,
            message: error.response?.data?.message || 'OTP verification failed',
            error: error.response?.data || error.message
        });
    }
};
