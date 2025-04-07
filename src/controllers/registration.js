// src/controllers/registration.js

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { logger } from '../logger.js';
import fs from 'fs/promises';
import path from 'path';
import connectDB from '../db/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const SALT_ROUNDS = 10;

export const checkAadharExists = async (req, res) => {
    const pool = await connectDB();
    let connection;

    try {
        connection = await pool.getConnection();
        const { aadharNumber } = req.body;

        // Check if Aadhar number exists in customer_details
        const [existingUser] = await connection.query(
            'SELECT id FROM customer_details WHERE aadhar_number = ?',
            [aadharNumber]
        );

        res.json({
            success: true,
            exists: existingUser && existingUser.length > 0,
            message: existingUser && existingUser.length > 0 ? 
                'This Aadhar number is already registered.' : 
                'Aadhar number is available for registration.'
        });
    } catch (error) {
        logger.error('Error checking Aadhar existence:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check Aadhar number',
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
};

export const verifyRegistrationToken = async (req, res) => {
    try {
        const { token } = req.query;
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({
            success: true,
            data: decoded,
            requiresAadhar: decoded.countryCode === 'IN'
        });
    } catch (error) {
        logger.error('Error verifying registration token:', error);
        res.status(400).json({
            success: false,
            message: 'Invalid or expired registration token'
        });
    }
};

export const uploadPassport = async (req, res) => {
    const pool = await connectDB();
    let connection;

    try {
        connection = await pool.getConnection();
        const { email, password, username, telephone, address, card_select, card_detail, company_name, company_gst } = req.body;

        // Validate required fields
        if (!email || !password || !username || !telephone) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Check if user exists
        const [existingUser] = await connection.query('SELECT * FROM register WHERE email = ?', [email]);
        if (!existingUser.length) {
            return res.status(404).json({ message: 'User not found. Please complete registration first.' });
        }

        // Check if file exists
        if (!req.files || !req.files.passport) {
            console.log('No passport file found in request');
            return res.status(400).json({ message: 'No passport file uploaded' });
        }

        const uploadedFile = req.files.passport;
        console.log('File details:', {
            name: uploadedFile.name,
            size: uploadedFile.size,
            mimetype: uploadedFile.mimetype
        });

        // Validate file size (max 5MB)
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
        if (uploadedFile.size > MAX_FILE_SIZE) {
            console.log('File too large:', uploadedFile.size);
            return res.status(400).json({ message: 'File size exceeds 5MB limit' });
        }

        // Get file extension
        const fileExtension = path.extname(uploadedFile.name).toLowerCase();
        
        // Validate file type
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];
        if (!allowedExtensions.includes(fileExtension)) {
            console.log('Invalid file type:', uploadedFile.name);
            return res.status(400).json({ 
                message: 'Only image and PDF files (.jpg, .jpeg, .png, .pdf) are allowed',
                allowedFormats: allowedExtensions
            });
        }

        // Create directory if it doesn't exist
        const uploadDir = path.join('uploads', 'passports', email);
        await fs.mkdir(uploadDir, { recursive: true });

        // Generate unique filename
        const uniqueFilename = `${Date.now()}-${uploadedFile.name}`;
        const uploadPath = path.join(uploadDir, uniqueFilename);
        console.log('Upload path:', uploadPath);

        // Move file to upload location
        await uploadedFile.mv(uploadPath);

        await connection.beginTransaction();

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Update user data in register table with password and passport
        await connection.query(
            'UPDATE register SET password = ?, passport_file_path = ?, card_select = ?, verified = ? WHERE email = ?',
            [hashedPassword, uploadPath, 'Passport', 'no', email]
        );

        await connection.commit();

        res.status(200).json({ 
            success: true,
            message: 'Password set and passport uploaded successfully. You will be verified shortly.',
            filePath: uploadPath,
            originalName: uploadedFile.name,
            size: uploadedFile.size
        });
    } catch (error) {
        if (connection) await connection.rollback();
        logger.error('Error in passport upload:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during upload'
        });
    } finally {
        if (connection) connection.release();
    }
};

// Register User (without role)
export const registerCustomer = async (req, res) => {
    const { username, telephone, email, password, address, 
        card_select, card_detail, 
        company_name, company_gst,
        is_indian_national, passport_base } = req.body; 

    // Validate required fields
    if (!username || !telephone || !email || !password || !address || !card_select || 
        (is_indian_national === true && !card_detail) || 
        (is_indian_national === false && !passport_base)) {
        return res.status(400).json({
            success: false,
            message: 'All required fields must be provided'
        });
    }

    try {
        const connection = await connectDB();
        
        // Check if user exists
        const [existingUser] = await connection.query(
            'SELECT * FROM register WHERE email = ?',
            [email]
        );

        if (!existingUser || existingUser.length === 0) {
            logger.warn(`Registration failed: User not found for email: ${email}`);
            return res.status(404).json({ 
                success: false,
                message: 'Registration not found. Please complete the payment process first.' 
            });
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            // Hash password
            const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

            let passport_file_path = null;

            // Handle passport file upload for non-Indian nationals
            if (is_indian_national === false && passport_base) {
                try {
                    const uploadPassport = req.files.file;
                    const fileExtension = path.extname(uploadPassport.name).toLowerCase();
            
                    // Define allowed extensions
                    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];

                    if (!allowedExtensions.includes(fileExtension)) {
                        await connection.rollback();
                        return res.status(400).json({ 
                            success: false,
                            message: 'Unsupported file format. Please upload JPG, JPEG, PNG, or PDF files.' 
                        });
                    }

                    if (uploadPassport.size > 5 * 1024 * 1024) { // 5MB limit
                        await connection.rollback();
                        return res.status(400).json({ 
                            success: false,
                            message: 'File size too large. Maximum size is 5MB.' 
                        });
                    }

                    // Create a unique filename
                    const uniquePassname = `${Date.now()}-${uploadPassport.name}`;
                    const uploadPath = path.join(__dirname, '../../uploads/passports', email, uniquePassname);

                    // Ensure the directory exists
                    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
            
                    // Move the file to the target location
                    await uploadPassport.mv(uploadPath);
                    passport_file_path = path.join('uploads/passports', email, uniquePassname);

                } catch (error) {
                    await connection.rollback();
                    logger.error(`Passport file processing error for ${email}: ${error.message}`);
                    return res.status(500).json({
                        success: false,
                        message: 'Error processing passport file'
                    });
                }
            }

            // Update user with registration details
            await connection.query(
                `UPDATE register SET 
                username = ?, 
                telephone = ?,
                password = ?,
                address = ?,
                card_select = ?,
                card_detail = ?,
                company_name = ?,
                company_gst = ?,
                is_indian_national = ?,
                passport_file_path = ?,
                verified = CASE 
                    WHEN ? = 0 THEN 'yes'  -- For passport users
                    ELSE 'no'              -- For Aadhar users
                END
                WHERE email = ?`,
                [
                    username,
                    telephone,
                    hashedPassword,
                    address,
                    card_select,
                    card_detail,
                    company_name || null,
                    company_gst || null,
                    is_indian_national,
                    passport_file_path,
                    is_indian_national,  // Used in CASE statement for verified status
                    email
                ]
            );

            // Commit transaction
            await connection.commit();

            logger.info(`User registered successfully: ${email}`);
            return res.json({
                success: true,
                message: is_indian_national
                    ? 'Registration successful! Please proceed with Aadhar verification.'
                    : 'Registration completed successfully. Your passport will be verified shortly.'
            });

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        logger.error(`Registration error for ${email}: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: 'Registration failed. Please try again later.'
        });
    }
};

export const setPassword = async (req, res) => {
    const pool = await connectDB();
    let connection;

    try {
        connection = await pool.getConnection();
        const { password, token } = req.body;
        const decoded = jwt.verify(token, JWT_SECRET);

        // Validate password
        if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        await connection.beginTransaction();

        // Update register table with password
        await connection.query(
            'UPDATE register SET password = ?, verified = ? WHERE email = ?',
            [hashedPassword, 'yes', decoded.email]
        );

        await connection.commit();

        res.json({
            success: true,
            message: 'Password set successfully'
        });
    } catch (error) {
        if (connection) await connection.rollback();
        logger.error('Error setting password:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while setting password'
        });
    } finally {
        if (connection) connection.release();
    }
};

export const checkEmailRegistration = async (req, res) => {
    const pool = await connectDB();
    let connection;

    try {
        connection = await pool.getConnection();
        const { email } = req.params;

        logger.info('Checking email registration for:', { email });

        // First check if user is already registered in register table
        const [registeredUser] = await connection.query(
            'SELECT id FROM register WHERE email = ? AND password IS NOT NULL AND password != "" AND verified = "yes"',
            [email]
        );

        const isRegistered = registeredUser.length > 0;

        // If registered, return early with registered status
        if (isRegistered) {
            return res.status(200).json({
                success: true,
                isRegistered: true,
                message: 'User already registered. Thanks for successful renewal!'
            });
        }

        // If not registered, check if email exists in website_registration
        const [rows] = await connection.query(
            `SELECT 
                id, 
                f_name, 
                l_name, 
                phone, 
                email, 
                address, 
                company_name,
                card_type
            FROM website_registration 
            WHERE email = ? 
            ORDER BY id DESC LIMIT 1`,
            [email]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                isRegistered: false,
                message: 'Email not found in registrations. Please complete the payment process first.'
            });
        }

        // Return user details with country code
        return res.status(200).json({
            success: true,
            isRegistered: false,
            data: {
                firstName: rows[0].f_name,
                lastName: rows[0].l_name,
                phone: rows[0].phone,
                email: rows[0].email,
                address: rows[0].address || "",
                company_name: rows[0].company_name || "",
                company_gst: "", // Default empty string since column doesn't exist
                countryCode: rows[0].card_type === 'Aadhar' ? 'IN' : 'AUS'  // Set countryCode based on card_type
            }
        });

    } catch (error) {
        logger.error('Error checking email registration:', error);
        return res.status(500).json({
            success: false,
            message: 'Error checking email registration',
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
};
