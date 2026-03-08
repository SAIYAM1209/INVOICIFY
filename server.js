const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3001;

// --- Middleware ---
app.use(cors({
  origin: 'http://localhost:3000'
}));
app.use(express.json());


// --- Database Connection ---
// !!! IMPORTANT: Replace 'YOUR_DB_PASSWORD_HERE' with your actual database password
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'postgres', // Based on your psql.log
  password: '1234', // <-- FIX THIS
  port: 5432,
});

// Test DB connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('Error executing query', err.stack);
    }
    console.log('Successfully connected to database at:', result.rows[0].now);
  });
});

// --- API Endpoints ---

// GET All Invoices
app.get('/api/invoices', async (req, res) => {
  console.log('GET /api/invoices - Fetching invoices...');
  const client = await pool.connect();
  try {
    // 1. Get all invoices with customer names
    const invoiceQuery = `
      SELECT 
        i.invoice_id, 
        i.invoice_date, 
        COALESCE(i.due_date, i.invoice_date + INTERVAL '30 days') as due_date, 
        i.grand_total, 
        i.status, 
        c.name as customer_name
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.customer_id
    `;
    const invoiceRes = await client.query(invoiceQuery);

    // --- FIX: Get all invoice items ---
    const itemsRes = await client.query('SELECT * FROM invoice_items');
    
    // Group items by invoice_id for easy lookup
    const itemsMap = new Map();
    itemsRes.rows.forEach(item => {
      if (!itemsMap.has(item.invoice_id)) {
        itemsMap.set(item.invoice_id, []);
      }
      itemsMap.get(item.invoice_id).push({
        item_id: item.item_id,
        product_id: item.product_id,
        item_name: item.item_name,
        quantity: item.quantity,
        price: parseFloat(item.price),
        tax: parseFloat(item.tax)
      });
    });
    // --- END OF FIX ---

    // Map invoices and attach their items
    const invoices = invoiceRes.rows.map(row => ({
      id: row.invoice_id,
      customer: row.customer_name || 'N/A',
      date: row.invoice_date,
      dueDate: row.due_date,
      amount: parseFloat(row.grand_total), 
      status: row.status,
      items: itemsMap.get(row.invoice_id) || [] // Attach items here
    }));
    
    res.json(invoices);
  } catch (err) {
    console.error('Error in /api/invoices:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST a new Invoice
app.post('/api/invoices', async (req, res) => {
  const { invoice_id, customerId, invoice_date, due_date, status, items } = req.body;
  console.log(`POST /api/invoices - Creating invoice ${invoice_id}`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const invoiceQuery = `
      INSERT INTO invoices (invoice_id, customer_id, invoice_date, due_date, status, sub_total, gst_total, grand_total)
      VALUES ($1, $2, $3, $4, $5, 0, 0, 0)
      RETURNING *
    `;
    await client.query(invoiceQuery, [invoice_id, customerId, invoice_date, due_date, status]);

    let sub_total = 0;
    let gst_total = 0;

    for (const item of items) {
      const itemQuery = `
        INSERT INTO invoice_items (invoice_id, product_id, item_name, quantity, price, tax)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await client.query(itemQuery, [
        invoice_id,
        item.product_id,
        item.item_name,
        item.quantity,
        item.price,
        item.tax
      ]);
      
      sub_total += (item.quantity * item.price);
      gst_total += item.tax;
    }
    
    const grand_total = sub_total + gst_total;

    const updateQuery = `
      UPDATE invoices
      SET sub_total = $1, gst_total = $2, grand_total = $3
      WHERE invoice_id = $4
    `;
    await client.query(updateQuery, [sub_total, gst_total, grand_total, invoice_id]);

    await client.query('COMMIT');

    const finalQuery = `
      SELECT 
        i.invoice_id, i.invoice_date, i.due_date, i.grand_total, i.status, 
        c.name as customer_name
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.customer_id
      WHERE i.invoice_id = $1
    `;
    const { rows } = await client.query(finalQuery, [invoice_id]);
    
    const newInvoice = {
      id: rows[0].invoice_id,
      customer: rows[0].customer_name,
      date: rows[0].invoice_date,
      dueDate: rows[0].due_date,
      amount: parseFloat(rows[0].grand_total),
      status: rows[0].status,
      items: items 
    };

    res.status(201).json(newInvoice); 

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in POST /api/invoices:', err.message);
    res.status(500).json({ error: 'Failed to create invoice' });
  } finally {
    client.release();
  }
});


// GET All Customers
app.get('/api/customers', async (req, res) => {
  console.log('GET /api/customers - Fetching customers...');
  try {
    const { rows } = await pool.query('SELECT * FROM customers');
    const customers = rows.map(row => ({
      id: row.customer_id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: row.billing_address,
      gstin: row.gstin,
      status: row.status,
      creditLimit: parseFloat(row.credit_limit),
      paymentTerms: row.payment_terms,
      totalSpent: parseFloat(row.total_spent),
      outstandingBalance: parseFloat(row.outstanding_balance)
    }));
    res.json(customers);
  } catch (err) {
    console.error('Error in /api/customers:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET All Products
app.get('/api/products', async (req, res) => {
  console.log('GET /api/products - Fetching products...');
  try {
    const { rows } = await pool.query('SELECT * FROM products');
    const products = rows.map(row => ({
      id: row.product_id,
      name: row.name,
      sku: row.sku,
      description: row.description,
      price: parseFloat(row.unit_price),
      quantity: parseInt(row.stock_quantity, 10),
      supplierId: row.supplier_id,
      barcode: row.barcode,
      unit: row.unit,
      category: row.category,
      costPrice: parseFloat(row.cost_price),
      reorderLevel: parseInt(row.reorder_level, 10),
      taxRate: parseFloat(row.tax_rate)
    }));
    res.json(products);
  } catch (err) {
    console.error('Error in /api/products:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET All Suppliers
app.get('/api/suppliers', async (req, res) => {
  console.log('GET /api/suppliers - Fetching suppliers...');
  try {
    const { rows } = await pool.query('SELECT * FROM suppliers');
    const suppliers = rows.map(row => ({
      id: row.supplier_id, 
      name: row.name,
      contactPerson: row.contact_person,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      address: row.address,
      gstin: row.gstin,
      paymentTerms: row.payment_terms,
      creditLimit: parseFloat(row.credit_limit),
      status: row.status,
      rating: parseInt(row.rating, 10)
    }));
    res.json(suppliers);
  } catch (err) {
    console.error('Error in /api/suppliers:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT (Update) a Product (for StockAdjustment AND ProductForm)
app.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    name, sku, description, category, price, costPrice, 
    quantity, reorderLevel, supplierId, barcode, taxRate, unit 
  } = req.body;

  console.log(`PUT /api/products/${id} - Updating product...`);

  try {
    const query = `
      UPDATE products 
      SET 
        name = COALESCE($1, name),
        sku = COALESCE($2, sku),
        description = COALESCE($3, description),
        category = COALESCE($4, category),
        unit_price = COALESCE($5, unit_price),
        cost_price = COALESCE($6, cost_price),
        stock_quantity = COALESCE($7, stock_quantity),
        reorder_level = COALESCE($8, reorder_level),
        supplier_id = COALESCE($9, supplier_id),
        barcode = COALESCE($10, barcode),
        tax_rate = COALESCE($11, tax_rate),
        unit = COALESCE($12, unit)
      WHERE product_id = $13
      RETURNING *
    `;
    
    const { rows } = await pool.query(query, [
      name, sku, description, category, price, costPrice,
      quantity, reorderLevel, supplierId, barcode, taxRate, unit,
      id
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Translate DB response back to frontend format
    const row = rows[0];
    const updatedProduct = {
      id: row.product_id,
      name: row.name,
      sku: row.sku,
      description: row.description,
      category: row.category,
      price: parseFloat(row.unit_price),
      costPrice: parseFloat(row.cost_price),
      quantity: parseInt(row.stock_quantity, 10),
      reaorderLevel: parseInt(row.reorder_level, 10),
      supplierId: row.supplier_id,
      barcode: row.barcode,
      taxRate: parseFloat(row.tax_rate),
      unit: row.unit
    };

    res.json(updatedProduct);
  } catch (err) {
    console.error('Error in /api/products/:id:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});