// src/controllers/saveNumbers.js

import connectDB from '../db/index.js';
import csv from 'csv-parser';
import { Readable } from 'stream';

// Function to save phone numbers to the database
export const saveCSVDataToDB = async (req) => {
    if (!req.files || !req.files.file) {
        throw new Error('No CSV file uploaded');
    }
    const instanceId = req.params.id;
    const csvFile = req.files.file;
    const results = [];
    const phoneNumbers = [];

    // Validate file type
    if (!csvFile.name.toLowerCase().endsWith('.csv')) {
        throw new Error('Only CSV files are allowed');
    }

    try {
        console.log('Processing CSV for instance:', instanceId);
        const csvContent = csvFile.data.toString();
        const stream = Readable.from(csvContent);

        // Parse CSV and collect phone numbers
        await new Promise((resolve, reject) => {
            stream
                .pipe(csv())
                .on('data', (data) => {
                    console.log('Parsed row:', data); // Log parsed data for debugging

                    // Access the phone number directly from the 'phone_numbers' field
                    const phone = data.phone_numbers;

                    if (phone) {
                        // Clean and format the phone number
                        const cleanPhone = phone.replace(/[\s\-\(\)]/g, '').trim();
                        const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;

                        // Validate phone number format (adjust regex as needed)
                        if (/^\+\d{10,15}$/.test(formattedPhone)) { // Ensure it starts with '+' and has 10-15 digits
                            phoneNumbers.push(formattedPhone);
                            results.push({
                                phone_numbers: formattedPhone,
                                name: data.name || null
                            });
                        } else {
                            console.warn('Invalid phone number format:', formattedPhone);
                        }
                    } else {
                        console.warn('No phone number in row:', data);
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });

        if (phoneNumbers.length === 0) {
            throw new Error('No valid phone numbers found in CSV');
        }

        console.log('Valid phone numbers:', phoneNumbers);

        // Get database connection
        const connection = await connectDB();

        // Insert all numbers into the database
        for (const row of results) {
            try {
                await connection.query(
                    `INSERT INTO phoneList (phone_numbers, name, created_at, instance_id) 
                     VALUES (?, ?, NOW(), ?)`,
                    [row.phone_numbers, row.name, instanceId]
                );
            } catch (insertError) {
                console.error('Error inserting row:', insertError);
            }
        }

        return {
            phoneNumbers,
            totalNumbers: phoneNumbers.length
        };

    } catch (error) {
        console.error('Error processing CSV:', error);
        throw error;
    }
};
