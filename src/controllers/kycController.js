// src/controllers/kycController.js

import fetch from 'node-fetch';
import connectDB from '../db/index.js';
import bcrypt from 'bcrypt';

const MAX_TOTAL_ATTEMPTS = 3; // Maximum total attempts including resends

// Store registration data temporarily (in production, use Redis or a proper session store)
const tempRegistrationStore = new Map();

const initiateKYC = async (req, res) => {
    try {
        const { 
            uniqueId, 
            uid,
            f_name,
            l_name,
            email,
            phone,
            address,
            company_name,
            password,
            card_select,
            card_detail,
            company_gst,
            isResend = false,
            totalAttempts = 0
        } = req.body;

        // Check total attempts (including current attempt)
        if (totalAttempts >= (isResend ? 2 : 3)) { // For resend, check if we've already had 2 attempts
            return res.status(400).json({
                success: false,
                message: "Maximum attempts reached. Please contact support@voicemeetme.com",
                maxAttemptsExceeded: true,
                redirectTo: "/login"
            });
        }

        // Store registration data in temporary storage
        if (!isResend && email) {
            tempRegistrationStore.set(email, {
                f_name,
                l_name,
                email,
                phone,
                address,
                company_name,
                password: password ? await bcrypt.hash(password, 10) : null,
                card_select,
                card_detail,
                company_gst
            });
        }

        // If no Aadhar provided or not using Aadhar, skip KYC
        if (!uid || card_select !== 'Aadhar') {
            return res.json({
                success: true,
                proceedToLogin: true,
                message: 'Registration successful! Please login to continue.'
            });
        }

        // Proceed with KYC/OTP generation
        if (!uniqueId || !uid) {
            return res.status(400).json({
                success: false,
                message: 'uniqueId and uid are required for OTP generation'
            });
        }

        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/intiate-kyc-auto', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({ uniqueId, uid })
        });
        
        const data = await response.json();
        
        if (data.code === "200") {
            // Ensure we always return the model data for transaction details
            const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
            return res.json({
                ...data,
                success: true,
                message: isResend ? 
                    `OTP resent successfully! (${remainingAttempts} ${remainingAttempts === 1 ? 'attempt' : 'attempts'} remaining)` : 
                    'OTP sent successfully',
                model: {
                    transactionId: data.model?.transactionId,
                    fwdp: data.model?.fwdp,
                    codeVerifier: data.model?.codeVerifier
                },
                remainingAttempts
            });
        } else {
            const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts;
            return res.status(400).json({
                ...data,
                success: false,
                message: isResend ? 'Failed to resend OTP' : 'Failed to send OTP',
                remainingAttempts
            });
        }
    } catch (error) {
        console.error('KYC Initiation Error:', error);
        res.status(500).json({ 
            success: false,
            message: error.message || 'Failed to process request'
        });
    }
};

const submitOTP = async (req, res) => {
    const startTime = Date.now();
    const pool = await connectDB();
    let connection;
    
    try {
        connection = await pool.getConnection();
        const { 
            transactionId, 
            fwdp, 
            codeVerifier, 
            otp, 
            shareCode, 
            email,
            registeredName,
            aadharName, 
            totalAttempts = 0
        } = req.body;

        // Log the request data for debugging
        console.log('OTP Verification Request:', {
            transactionId,
            fwdp,
            codeVerifier,
            otp,
            totalAttempts
        });

        // Validate required fields
        if (!transactionId || !fwdp || !codeVerifier || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields for OTP verification'
            });
        }
        
        // Check if maximum attempts exceeded
        if (totalAttempts >= MAX_TOTAL_ATTEMPTS) {
            console.log('Maximum OTP attempts exceeded:', {
                email,
                totalAttempts,
                maxAttempts: MAX_TOTAL_ATTEMPTS
            });
            tempRegistrationStore.delete(email);
            return res.status(400).json({
                success: false,
                message: "Maximum attempts reached. Please contact our support team for assistance.",
                maxAttemptsReached: true,
                redirectTo: '/login'
            });
        }

        const apiStartTime = Date.now();
        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/submit-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({
                transactionId,
                fwdp,
                codeVerifier,
                otp,
                shareCode,
                isSendPdf: true
            })
        });
        
        const data = await response.json();
        const apiEndTime = Date.now();
        console.log('OTP API Response Time:', apiEndTime - apiStartTime, 'ms');
        console.log('OTP API Response:', data);

        // If OTP verification fails, return error immediately with remaining attempts
        if (!response.ok || data.code !== "200") {
            console.error('OTP Verification failed:', data);
            return res.status(400).json({
                success: false,
                remainingAttempts: MAX_TOTAL_ATTEMPTS - totalAttempts - 1,
                message: data.message || "Failed to verify OTP",
                errorCode: data.code,
                errorDetails: data.error || data.message
            });
        }

        const { password } = req.body;
        if (!password) {
            return res.status(400).json({
                success: false,
                message: 'Password is required for registration'
            });
        }

        const registrationData = email ? tempRegistrationStore.get(email) : null;

        if (!registrationData) {
            throw new Error('Registration data not found. Please try registering again.');
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Normalize phone number for storage
        const normalizePhoneNumber = (phone) => {
            if (!phone) return '';
            // Remove all non-digit characters except +
            const cleaned = phone.replace(/[^\d+]/g, '');
            // Ensure proper +91 prefix
            if (cleaned.startsWith('+91')) return cleaned;
            if (cleaned.startsWith('91')) return `+${cleaned}`;
            if (cleaned.startsWith('+')) return `+91${cleaned.substring(1)}`;
            return `+91${cleaned}`;
        };

        const phoneWithPrefix = normalizePhoneNumber(registrationData.phone);

        // Start transaction for customer_details
        await connection.beginTransaction();

        try {
            // Always store customer details after successful OTP verification
            await connection.query(`
                INSERT INTO customer_details (
                    unique_id, transaction_id, aadhar_number, 
                    masked_aadhar_number, name, gender, dob, 
                    care_of, pass_code, pdf_link, pdf_img_link, 
                    link, house, street, landmark, locality, 
                    post_office, district, sub_district, vtc, 
                    pincode, state, country
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    transaction_id = VALUES(transaction_id),
                    aadhar_number = VALUES(aadhar_number),
                    masked_aadhar_number = VALUES(masked_aadhar_number),
                    name = VALUES(name),
                    gender = VALUES(gender),
                    dob = VALUES(dob),
                    care_of = VALUES(care_of),
                    pass_code = VALUES(pass_code),
                    pdf_link = VALUES(pdf_link),
                    pdf_img_link = VALUES(pdf_img_link),
                    link = VALUES(link),
                    house = VALUES(house),
                    street = VALUES(street),
                    landmark = VALUES(landmark),
                    locality = VALUES(locality),
                    post_office = VALUES(post_office),
                    district = VALUES(district),
                    sub_district = VALUES(sub_district),
                    vtc = VALUES(vtc),
                    pincode = VALUES(pincode),
                    state = VALUES(state),
                    country = VALUES(country)
            `, [
                phoneWithPrefix,
                data.model.transactionId,
                data.model.adharNumber,
                data.model.maskedAdharNumber,
                data.model.name,
                data.model.gender,
                data.model.dob,
                data.model.careOf,
                data.model.passCode,
                data.model.pdfLink,
                data.model.pdfImgLink,
                data.model.link,
                data.model.address.house,
                data.model.address.street,
                data.model.address.landmark,
                data.model.address.loc,
                data.model.address.po,
                data.model.address.dist,
                data.model.address.subdist,
                data.model.address.vtc,
                data.model.address.pc,
                data.model.address.state,
                data.model.address.country
            ]);

            // Compare names from request before proceeding with verification
            if (!registeredName) {
                await connection.rollback();
                throw new Error('Registered name is required');
            }

            // Get Aadhaar name from response if not provided in request
            const actualAadharName = aadharName || data.model.name;
            if (!actualAadharName) {
                throw new Error('Could not get Aadhaar name from response');
            }

            const requestNameParts = registeredName.toLowerCase().trim().split(' ').filter(part => part.length > 0);
            const requestAadharParts = actualAadharName.toLowerCase().trim().split(' ').filter(part => part.length > 0);
            
            // Log the names being compared
            console.log('Comparing names:', {
                requestNameParts,
                requestAadharParts
            });

            // Check if all parts of registered name appear in Aadhar name parts
            const namesMatch = requestNameParts.every(part => 
                requestAadharParts.some(aadharPart => aadharPart.includes(part) || part.includes(aadharPart))
            );

            if (!namesMatch) {
                await connection.rollback();
                console.log('Name mismatch detected:', {
                    requestNameParts,
                    requestAadharParts
                });
                return res.status(400).json({
                    success: false,
                    message: "Your name doesn't match with your Aadhar details. Please try again with your actual Aadhar card number.",
                    nameMismatch: true,
                    goBack: true
                });
            }

            // Only update verification status if names match
            await connection.query(
                'UPDATE register SET password = ?, verified = ?, card_select = ?, card_detail = ? WHERE email = ?',
                [hashedPassword, 'yes', 'Aadhar', data.model.adharNumber, email]
            );

            await connection.commit();

            // Get registration data
            const registrationData = tempRegistrationStore.get(email);
            if (!registrationData || !registrationData.password) {
                return res.status(400).json({
                    success: false,
                    message: 'Registration data not found or missing password'
                });
            }

            // If we get here, names match successfully
            console.log('Name verification successful:', {
                requestNameParts,
                requestAadharParts
            });

            return res.status(200).json({
                success: true,
                message: 'Aadhar verification successful',
                nextStep: 'set_password'
            });

            // If names match, proceed with register table update
            // Clear session data after successful verification
            tempRegistrationStore.delete(email);
            
            return res.json({
                success: true,
                message: 'Registration completed successfully',
                redirectTo: "/login"
            });
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } catch (error) {
        console.error('OTP Submission Error:', error);
        return res.status(400).json({ 
            success: false,
            message: error.message || "Failed to verify OTP. Please try again.",
            errorCode: error.code || 'UNKNOWN_ERROR',
            errorDetails: error.stack
        });
    } finally {
        // Always release the connection
        if (connection) {
            try {
                await connection.rollback(); // Rollback any pending transactions
                connection.release();
            } catch (err) {
                console.error('Error releasing connection:', err);
            }
        }
    }
};

const resendOTP = async (req, res) => {
    try {
        const { transactionId, email, totalAttempts = 0 } = req.body;

        // Check total attempts (including current attempt)
        if (totalAttempts >= 2) { // Changed from 3 to 2 since this will be another attempt
            return res.status(400).json({
                success: false,
                maxAttemptsExceeded: true,
                message: "Maximum attempts reached. Please contact support@voicemeetme.com",
                redirectTo: "/login"
            });
        }

        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/resend-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({ transactionId })
        });

        const data = await response.json();
        const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
        
        return res.json({
            ...data,
            success: data.code === "200",
            remainingAttempts,
            message: data.code === "200" ? 
                'OTP resent successfully!' :
                'Failed to resend OTP.'
        });
    } catch (error) {
        console.error('Resend OTP Error:', error);
        const remainingAttempts = MAX_TOTAL_ATTEMPTS - (totalAttempts || 0) - 1;
        res.status(500).json({ 
            error: error.message,
            success: false,
            remainingAttempts,
            message: "Failed to resend OTP. Please try again."
        });
    }
};

// Add new endpoint for checking verification status
const checkVerification = async (req, res) => {
    try {
        const pool = await connectDB();
        const connection = await pool.getConnection();

        try {
            // Get email from either request body (POST) or params (GET)
            const email = req.body.email || req.params.instance_id;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Email is required',
                    verified: 'no'
                });
            }

            // Check verification status in register table
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
                verified: rows[0].verified
            });

        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Check Verification Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to check verification status',
            verified: 'no'
        });
    }
};

const saveCustomerDetails = async (req, res) => {
    const pool = await connectDB();
    let connection;

    try {
        connection = await pool.getConnection();
        const { aadharName, username, phone } = req.body;

        console.log('Received customer details:', { aadharName, username, phone });

        if (!aadharName || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name or phone'
            });
        }

        // Start transaction
        await connection.beginTransaction();

        // Update or insert into customer_details
        const [result] = await connection.query(
            `INSERT INTO customer_details (name, unique_id) 
             VALUES (?, ?) 
             ON DUPLICATE KEY UPDATE name = ?, unique_id = ?`,
            [aadharName, phone, aadharName, phone]
        );

        console.log('Database operation result:', result);

        // Commit transaction
        await connection.commit();

        return res.json({
            success: true,
            message: 'Customer details saved successfully'
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        console.error('Error saving customer details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save customer details'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

const getCustomerDetails = async (req, res) => {
    const pool = await connectDB();
    let connection;
    
    try {
        connection = await pool.getConnection();
        const { phone } = req.query;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // Get customer details from database
        const [customerDetails] = await connection.query(
            'SELECT username, email, telephone, card_detail FROM register WHERE telephone = ?',
            [phone]
        );

        if (!customerDetails || customerDetails.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Customer details not found'
            });
        }

        // Map fields to expected names
        const mappedDetails = {
            name: customerDetails[0].username,
            email: customerDetails[0].email,
            phone: customerDetails[0].telephone,
            card_detail: customerDetails[0].card_detail
        };

        return res.json({
            success: true,
            customerDetails: mappedDetails
        });

    } catch (error) {
        console.error('Error fetching customer details:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch customer details'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

export { initiateKYC, submitOTP, resendOTP, checkVerification, saveCustomerDetails, getCustomerDetails };
