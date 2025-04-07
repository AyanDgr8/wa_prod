// src/routes/router.js

import express from 'express';
import connectDB from '../db/index.js';
import { logger } from '../logger.js';

import {
    loginCustomer, 
    logoutCustomer, 
    fetchCurrentUser,
    forgotPassword,
    resetPassword,
    sendOTP,
    resetPasswordWithToken,
    checkRegistration,
    savePassword,
    checkUserPassword,
    checkSession
} from '../controllers/sign.js';

import {
    registerCustomer
} from '../controllers/registration.js';

import { verifyRegistration, verifyContact } from '../controllers/verify.js';

import { resetInstance, generateQRCode, getConnectionStatus } from '../controllers/qrcode.js';

import { saveInstanceToDB } from '../controllers/instances.js';

import { uploadMedia, uploadCSV } from '../controllers/fileUpload.js';

import { sendMedia } from '../controllers/messages.js';
import { getSubscriptionDetails, checkSubscription } from '../controllers/subscription.js';
// import { saveScheduledMessage } from '../controllers/schedule.js';

import { authenticateToken, attachWhatsAppInstance } from '../middlewares/auth.js';
import { validateSession } from '../middlewares/sessionMiddleware.js';

// Add this with your other imports
import { handleWebhook } from '../controllers/webhook.js';
import {
    verifyRegistrationToken,
    checkAadharExists,
    uploadPassport,
    setPassword,
    checkEmailRegistration
} from '../controllers/registration.js';  

// import { getMessageReports, getMessageStatusSummary, getDailyMessageCount } from '../controllers/reports.js';
import { initiateKYC, submitOTP, checkVerification, saveCustomerDetails, getCustomerDetails } from '../controllers/kycController.js';

const router = express.Router();


// KYC routes
router.post('/kyc/initiate', initiateKYC);
router.post('/kyc/submit-otp', submitOTP);
router.post('/kyc/save-details', saveCustomerDetails);
router.get('/kyc/get-customer-details', getCustomerDetails);

// Instance verification
router.get('/verify/user/:email', authenticateToken, verifyContact); 

// Session routes
router.get('/check-session', validateSession, checkSession);

// Route for checking if email is already registered
router.get('/check-registration/:email', checkRegistration);

// Route for verifying registration status
router.get('/verify/registration/:email', verifyRegistration);

// Route for user registration
router.post('/register', registerCustomer);

// Route for user login
router.post('/login', loginCustomer);

// Route for sending OTP (reset password link)
router.post('/send-otp', sendOTP);

// Route for resetting password with token
router.post('/reset-password/:id/:token', resetPasswordWithToken);

// Route for forgot password
router.post('/forgot-password', forgotPassword);

// Route for reset password
router.post('/reset-password/:token', resetPassword);

// Route for user logout
router.post('/logout', logoutCustomer);

// Route to fetch current user
router.get('/current-user', authenticateToken, fetchCurrentUser);

// Route for saving instance to database
router.post('/save-instance', authenticateToken, saveInstanceToDB);

// // Route for getting user instances
// router.get('/user-instances/:register_id', authenticateToken, getUserInstances);

// Route for saving password
router.post('/save-password', savePassword);

// Route for checking if user has password
router.post('/check-user-password', checkUserPassword);

// Route to get user's instance and connection status
router.get('/user-instance', authenticateToken, async (req, res) => {
    try {
        const connection = await connectDB();
        const email = req.user.email;

        // Get user's instance
        const [instances] = await connection.query(
            "SELECT instance_id FROM instances WHERE register_id = ?",
            [email]
        );

        if (instances.length === 0) {
            return res.json({ 
                hasInstance: false 
            });
        }

        const instanceId = instances[0].instance_id;
        
        // Get connection status from the WhatsApp instances object
        let status = 'disconnected';
        const whatsappInstance = instances[instanceId];
        if (whatsappInstance && whatsappInstance.status) {
            status = whatsappInstance.status;
        }
        
        res.json({
            hasInstance: true,
            instanceId: instanceId,
            isConnected: status === 'connected'
        });
    } catch (error) {
        logger.error("Error fetching user instance:", error);
        res.status(500).json({ 
            success: false, 
            message: "Failed to fetch instance details",
            error: error.message 
        });
    }
});

// Wix Payment Webhook endpoint
router.post('/webhook/registration', express.json(), handleWebhook);

// Registration routes
router.get('/check-registration/:email', checkRegistration);
router.get('/check-email-registration/:email', checkEmailRegistration);
router.get('/registration/verify-token', verifyRegistrationToken);
router.post('/registration/check-aadhar', checkAadharExists);
router.post('/registration/upload-passport', uploadPassport);
router.post('/registration/set-password', express.json(), setPassword);

// KYC routes
router.post('/kyc/initiate', initiateKYC);
router.post('/kyc/submit-otp', submitOTP);
router.post('/kyc/save-details', saveCustomerDetails);  // No auth needed during registration

// KYC verification
router.get('/:email/check-kyc', authenticateToken, checkVerification);

// Protected instance routes
router.get('/:id/qrcode', authenticateToken, generateQRCode);
router.get('/:id/status', authenticateToken, getConnectionStatus);
router.post('/:id/reset', authenticateToken, resetInstance);

// Subscription routes
router.get('/:id/subscription', authenticateToken,  getSubscriptionDetails);
router.get('/:id/check-subscription', authenticateToken, checkSubscription); 

// File upload routes
router.post('/:id/upload-media', authenticateToken, uploadMedia);
router.post('/:id/upload-csv', authenticateToken, uploadCSV);

// Route for sending media
router.post('/:instanceId/send-media', authenticateToken, attachWhatsAppInstance, sendMedia);

// // Route for scheduling messages
// router.post('/schedule-message', authenticateToken, async (req, res) => {
//     try {
//         const { instance_id, recipient, message, schedule_time, media, caption } = req.body;
        
//         if (!instance_id || !recipient || !message ) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Missing required fields"
//             });
//         }

//         // Only validate schedule_time if it's provided
//         if (schedule_time) {
//             const scheduledTime = new Date(schedule_time);
//             if (scheduledTime <= new Date()) {
//                 return res.status(400).json({
//                     success: false,
//                     messaxge: "Schedule time must be in the future"
//                 });
//             }
//         }

//         const savedIds = await saveScheduledMessage(instance_id, recipient, message, media || null, caption || null, schedule_time);
        
//         res.json({
//             success: true,
//             message: "Message scheduled successfully",
//             data: savedIds
//         });
//     } catch (error) {
//         console.error('Error scheduling message:', error);
//         res.status(500).json({
//             success: false,
//             message: error.message
//         });
//     }
// });

// Add this with your other routes
router.post('/wix-webhook', express.json(), async (req, res) => {
    try {
        const result = await handleWebhook(req.body);
        res.json(result);
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// // Message reports routes
// router.get('/:instance_id/message-reports', authenticateToken, getMessageReports);
// router.get('/:instance_id/message-status-summary', authenticateToken, getMessageStatusSummary);
// router.get('/:instance_id/daily-message-count', authenticateToken, getDailyMessageCount);


router.get('/verify-registration/:email', verifyRegistration);

export default router;
