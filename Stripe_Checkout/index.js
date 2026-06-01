require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const path = require('path')
const fs = require('fs')

const app = express()
const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')

// Serve static files from the parent directory (Good Frame 2)
app.use(express.static(path.join(__dirname, '..')))

// FIX: Increase the JSON body limit to accept larger payloads (e.g., with image data)
app.use(express.json({ limit: '100mb' }))

app.set('view engine', 'ejs')

app.get('/', (req, res) => {
    res.render('index.ejs')
})

// Serve the success page
app.get('/success.html', (req, res) => {

    const filePath = path.resolve(__dirname, '..', 'Checkout', 'success.html');

    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        console.error('Success file not found at:', filePath);
        res.status(404).send('Success page not found');
    }
})

// Alternative success route without .html
app.get('/success', (req, res) => {
    const filePath = path.join(__dirname, '..', 'Checkout', 'success.html');
    res.sendFile(filePath);
})

// Add a route to catch any requests that might be going to the old path
app.get('/Views/success.html', (req, res) => {
    res.redirect('/success.html' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''));
})

// The route is updated to match the front-end fetch request
app.post('/create-checkout-session', async (req, res) => {
    try {

        const session = await stripe.checkout.sessions.create({
            // The line items are now taken from the request body
            line_items: req.body.items,
            mode: 'payment',
            shipping_address_collection: {
                // You can customize the allowed countries as needed
                allowed_countries: ['US', 'BR', 'AU']
            },
            success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/cancel`,
            // Add additional configuration to ensure URLs are used
            payment_method_types: ['card'],
            billing_address_collection: 'required'
        })


        // Respond with the session ID in JSON format
        res.json({ id: session.id })

    } catch (error) {
        console.error('Stripe Error:', error);
        // Send the actual error message for easier debugging
        res.status(500).json({ error: error.message || 'Failed to create session' });
    }
})

app.get('/complete', (req, res) => {
    // Simply redirect to our success page with the session_id
    res.redirect(`/success?session_id=${req.query.session_id}`);
})

app.get('/cancel', (req, res) => {
    // Redirects to the root page if the user cancels
    res.redirect('/')
})

app.listen(3000)
