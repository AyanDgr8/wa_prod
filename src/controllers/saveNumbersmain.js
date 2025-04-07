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
    let headers = [];

    // Validate file type
    if (!csvFile.name.toLowerCase().endsWith('.csv')) {
        throw new Error('Only CSV files are allowed');
    }

    try {
        console.log('Processing CSV for instance:', instanceId);
        const csvContent = csvFile.data.toString();
        const stream = Readable.from(csvContent);

        // Parse CSV and collect all data
        await new Promise((resolve, reject) => {
            let isFirstRow = true;
            stream
                .pipe(csv())
                .on('data', (data) => {
                    console.log('Parsed row:', data);

                    // Capture headers from first row
                    if (isFirstRow) {
                        headers = Object.keys(data);
                        isFirstRow = false;
                    }

                    const phone = data.phone_numbers;

                    if (phone) {
                        // Clean and format the phone number
                        const cleanPhone = phone.replace(/[\s\-\(\)]/g, '').trim();
                        const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;

                        // Validate phone number format
                        if (/^\+\d{10,15}$/.test(formattedPhone)) {
                            phoneNumbers.push(formattedPhone);
                            
                            // Store all columns from the CSV
                            const rowData = { ...data };
                            rowData.phone_numbers = formattedPhone; // Use formatted phone number
                            results.push(rowData);
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
        console.log('CSV Headers:', headers);

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
            totalNumbers: phoneNumbers.length,
            headers: headers,
            data: results
        };

    } catch (error) {
        console.error('Error processing CSV:', error);
        throw error;
    }
};
