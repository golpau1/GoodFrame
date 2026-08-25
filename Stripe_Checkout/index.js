require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')

const app = express()
const isProduction = process.env.NODE_ENV === 'production'
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || ''

if (!stripeSecretKey || (isProduction
    ? !stripeSecretKey.startsWith('sk_live_')
    : !stripeSecretKey.startsWith('sk_test_'))) {
    throw new Error(`STRIPE_SECRET_KEY must be a ${isProduction ? 'live' : 'test'} key in this environment`)
}

const stripe = require('stripe')(stripeSecretKey)
const defaultBaseUrl = isProduction
    ? 'https://goodframe.com.au'
    : 'http://localhost:3000'
const baseUrl = (process.env.BASE_URL || defaultBaseUrl).replace(/\/$/, '')
const siteRoot = path.join(__dirname, '..')
const homepagePath = path.join(siteRoot, 'index.html')
const cartPath = path.join(siteRoot, 'cart.html')
const priceBySize = Object.freeze({
    '210x297mm': 9900,
    '420x594mm': 23500,
    '594x841mm': 35000,
    '841x1189mm': 70000
})
const canonicalSizeByDimensions = Object.freeze({
    '210x297': '210x297mm',
    '200x300': '210x297mm',
    '420x594': '420x594mm',
    '400x600': '420x594mm',
    '594x841': '594x841mm',
    '600x900': '594x841mm',
    '841x1189': '841x1189mm',
    '800x1200': '841x1189mm',
    '900x1200': '841x1189mm'
})
const defaultAllowedOrigins = isProduction
    ? ['https://goodframe.com.au', 'https://www.goodframe.com.au']
    : [
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5500'
    ]
const allowedOrigins = (process.env.ALLOWED_ORIGINS || defaultAllowedOrigins.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

app.use((req, res, next) => {
    const origin = req.headers.origin

    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204)
    }

    next()
})

app.get(['/', '/index.html', '/home'], (req, res) => {
    res.sendFile(homepagePath)
})

app.get('/Homepage/Homepage.html', (req, res) => {
    res.redirect('/index.html')
})

// Serve static files from the parent directory (Good Frame 2)
app.use(express.static(siteRoot))

// FIX: Increase the JSON body limit to accept larger payloads (e.g., with image data)
app.use(express.json({ limit: '100mb' }))

app.set('views', path.join(__dirname, 'Views'))
app.set('view engine', 'ejs')

app.get(['/cart', '/cart.html'], (req, res) => {
    res.sendFile(cartPath)
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

function getRequestedSize(item) {
    const values = [
        item?.size,
        item?.price_data?.product_data?.name
    ]

    for (const value of values) {
        if (typeof value !== 'string') {
            continue
        }

        const dimensions = value
            .toLowerCase()
            .replace(/[\u00d7*]/g, 'x')
            .match(/(\d+)\s*x\s*(\d+)\s*mm/)

        if (!dimensions) {
            continue
        }

        const width = Number(dimensions[1])
        const height = Number(dimensions[2])
        const dimensionKey = [width, height]
            .sort((a, b) => a - b)
            .join('x')
        const size = canonicalSizeByDimensions[dimensionKey]

        if (size) {
            return size
        }
    }

    return null
}

function getOrderCode(item) {
    const productName = item?.price_data?.product_data?.name
    const values = [
        item?.uniqueCode,
        item?.orderCode,
        item?.code,
        item?.productName,
        item?.internalTitle,
        productName
    ]

    for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') {
            continue
        }

        const match = String(value).match(/\b(\d{6})\b/)
        if (match) {
            return match[1]
        }
    }

    return ''
}

function getItemDescription(item) {
    const directDescription = [
        item?.orientation,
        item?.frameColor ? `${item.frameColor} Frame` : '',
        item?.border
    ].filter(Boolean).join(' | ')
    const legacyDescription = item?.price_data?.product_data?.description
    const description = directDescription || legacyDescription || 'Custom framed print'

    return String(description).replace(/[\r\n]+/g, ' ').slice(0, 200)
}

function getArtworkObjectKey(value) {
    const key = typeof value === 'string' ? value : ''
    return /^uploads\/\d{4}\/\d{2}\/\d{2}\/\d{6}\/(?:original\.(?:jpg|jpeg|png|gif)|thumbnail\.png)$/.test(key)
        ? key
        : ''
}

function buildStripeLineItems(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
        throw new Error('Cart must contain between 1 and 10 items')
    }

    const lineItems = []
    let subtotal = 0

    items.forEach(item => {
        const productName = item?.price_data?.product_data?.name
        if (productName === 'Shipping') {
            return
        }

        const size = getRequestedSize(item)
        if (!size) {
            throw new Error('One or more cart items has an invalid frame size')
        }

        const requestedQuantity = Number(item?.quantity)
        const quantity = Number.isInteger(requestedQuantity)
            ? Math.min(Math.max(requestedQuantity, 1), 10)
            : 1
        const orderCode = getOrderCode(item)
        const unitAmount = priceBySize[size]
        subtotal += unitAmount * quantity

        const productData = {
            name: `Print & Frame - ${size}`,
            description: getItemDescription(item)
        }

        if (orderCode) {
            productData.metadata = {
                order_code: orderCode,
                frame_size: size,
                ...(getArtworkObjectKey(item.originalObjectKey) && {
                    original_object_key: getArtworkObjectKey(item.originalObjectKey)
                }),
                ...(getArtworkObjectKey(item.thumbnailObjectKey) && {
                    thumbnail_object_key: getArtworkObjectKey(item.thumbnailObjectKey)
                })
            }
        }

        const lineItem = {
            price_data: {
                currency: 'aud',
                product_data: productData,
                unit_amount: unitAmount
            },
            quantity
        }

        lineItems.push(lineItem)
    })

    if (lineItems.length === 0) {
        throw new Error('Cart does not contain any purchasable items')
    }

    if (subtotal <= 10000) {
        lineItems.push({
            price_data: {
                currency: 'aud',
                product_data: {
                    name: 'Shipping'
                },
                unit_amount: 1500
            },
            quantity: 1
        })
    }

    return lineItems
}

app.post('/create-checkout-session', async (req, res) => {
    let lineItems

    try {
        lineItems = buildStripeLineItems(req.body.items)
    } catch (error) {
        return res.status(400).json({ error: error.message })
    }

    try {
        const orderCodes = [...new Set(lineItems
            .map(item => item.price_data?.product_data?.metadata?.order_code)
            .filter(Boolean))]
        const orderCodeMetadataValue = orderCodes.map(code => `#${code}`).join(', ').slice(0, 500)
        const sessionOptions = {
            line_items: lineItems,
            mode: 'payment',
            shipping_address_collection: {
                allowed_countries: ['US', 'BR', 'AU']
            },
            success_url: `${baseUrl}/Checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/cart.html`,
            billing_address_collection: 'required'
        }

        if (orderCodes.length > 0) {
            sessionOptions.client_reference_id = orderCodes[0]
            sessionOptions.metadata = {
                order_codes: orderCodeMetadataValue
            }
            sessionOptions.payment_intent_data = {
                description: 'Good Frame Order',
                metadata: {
                    order_codes: orderCodeMetadataValue
                }
            }
        }

        const session = await stripe.checkout.sessions.create(sessionOptions)

        res.json({ id: session.id, url: session.url })
    } catch (error) {
        console.error('Stripe checkout request failed', {
            type: error?.type,
            code: error?.code,
            statusCode: error?.statusCode
        });
        res.status(502).json({ error: 'Stripe could not create the checkout session' });
    }
})

app.get('/complete', (req, res) => {
    // Simply redirect to our success page with the session_id
    res.redirect(`/success?session_id=${req.query.session_id}`);
})

app.get('/cancel', (req, res) => {
    // Redirects back to the cart if the user cancels
    res.redirect('/cart')
})

const port = process.env.PORT || 3000
app.listen(port, () => {
    console.log(`Stripe checkout server listening on port ${port}`)
})
