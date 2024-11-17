import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'
import sqlite3 from 'sqlite3';
import { Readable } from 'node:stream';
import { promisify } from 'util';
import { cors } from 'hono/cors'

const dbPath = './storage/database.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to the SQLite database.');
    createTable();
  }
});

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

async function createTable() {
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lookup_key TEXT NOT NULL UNIQUE,
      deletion_key TEXT NOT NULL UNIQUE,
      file_extension TEXT NOT NULL
    )`);
    console.log('Uploads table created or already exists.');
  } catch (err) {
    console.error('Error creating table:', err);
  }
}

const app = new Hono()
app.use('/*', cors())
const uploadsDir = './storage/uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const allowedTypes = ['image/png', 'image/jpg', 'image/jpeg', 'image/gif']

app.get('', async (c) => {
  return c.json({
    "Version": "14.1.0",
    "DestinationType": "FileUploader",
    "RequestMethod": "POST",
    "RequestURL": "https://i.kys.gay/upload",
    "Body": "MultipartFormData",
    "FileFormName": "file",
    "URL": "https://i.kys.gay/{json:lookupKey}",
    "DeletionURL": "https://i.kys.gay/delete/{json:deletionKey}",
    "ErrorMessage": "{json:error}"
  }, 200)
})

app.get('/:lookupKey', async (c) => {
  const lookupKey = c.req.param('lookupKey')
  if (!lookupKey) {
    return c.json({'error': 'Invalid lookup key provided'}, 400)
  }
  
  try {
    const row = await dbGet('SELECT file_extension FROM uploads WHERE lookup_key = ?', [lookupKey]);

    if (!row) {
      return c.json({ 'error': 'File not found' }, 404)
    }

    const filePath = path.join(uploadsDir, `${lookupKey}${row.file_extension}`)
    if (!fs.existsSync(filePath)) {
      return c.json({ 'error': 'File not found on server' }, 404)
    }

    const fileStream = fs.createReadStream(filePath)
    const webStream = Readable.toWeb(fileStream)
    return c.body(webStream, 200, {
      'Content-Type': `image/${row.file_extension.substring(1)}`,
      'Content-Disposition': `inline; filename="${lookupKey}${row.file_extension}"`
    })
  } catch (err) {
    console.error('Error querying database:', err)
    return c.json({ 'error': 'Error querying database' }, 500)
  }
})

app.post('/upload', async (c) => {
  const body = await c.req.parseBody()
  if(!body['file']) {
    return c.json({'error': 'No file provided'})
  }
  const file = body['file'];
  const fileName = file.name;
  const fileType = file.type;
  const fileSize = file.size;
  if(fileSize <= 0) {
    return c.json({'error': 'Invalid file provided'}, 400)
  }
  if(fileSize > 10 * 1024 * 1024) {
    return c.json({'error': 'The provided file is too big (max 10MB)'}, 400)
  }
  if(!allowedTypes.includes(fileType)) {
    return c.json({'error': `Invalid filetype provided (allowed types: ${allowedTypes.map(type => type.replace('image/', '')).join(', ')})`}, 400)
  }
  const lookupKey = nanoid();
  const deleteKey = nanoid();

  const fileExtension = path.extname(fileName);

  const saveName = `${lookupKey}${fileExtension}`;
  const filePath = path.join(uploadsDir, saveName);

  try {
    await dbRun(
      'INSERT INTO uploads (id, lookup_key, deletion_key, file_extension) VALUES (?, ?, ?, ?)',
      [null, lookupKey, deleteKey, fileExtension]
    );
    const arrayBuffer = await file.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    console.log(`File saved: ${filePath}`);
  } catch (error) {
    console.error('Error saving file or inserting into database:', error);
    return c.json({ 'error': 'Failed to save the file or update the database' }, 500);
  }

  return c.json({'lookupKey': lookupKey, 'deletionKey': deleteKey}, 201)
})

app.get('/delete/:deletionKey', async (c) => {
  const deletionKey = c.req.param('deletionKey')
  if (!deletionKey) {
    return c.json({'error': 'Invalid deletion key provided'}, 400)
  }

  try {
    const row = await dbGet('SELECT lookup_key, file_extension FROM uploads WHERE deletion_key = ?', [deletionKey]);

    if (!row) {
      return c.json({ 'error': 'File not found' }, 404)
    }

    const filePath = path.join(uploadsDir, `${row.lookup_key}${row.file_extension}`)
    if (!fs.existsSync(filePath)) {
      return c.json({ 'error': 'File not found on server' }, 404)
    }

    fs.unlinkSync(filePath)
    await dbRun('DELETE FROM uploads WHERE deletion_key = ?', [deletionKey]);

    return c.json({ 'message': 'File deleted successfully' }, 200)
  } catch (err) {
    console.error('Error deleting file:', err)
    return c.json({ 'error': 'Error deleting file' }, 500)
  }
})

const port = 5000
console.log(`Server is running on port ${port}`)

serve({
  fetch: app.fetch,
  port
})