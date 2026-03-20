const express    = require('express');
const { OpenAI } = require('openai');
const twilio     = require('twilio');
const { google } = require('googleapis');
const fetch      = require('node-fetch');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const SHEET_ID   = '1TJXFhnI-E_J83YQ8pK7dSFRhQTQuZGwLoMCTbMOdE8w';
const SHEET_NAME = 'RECETA';

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

async function consultarCatalogo() {
  try {
    const auth   = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId:     SHEET_ID,
      range:             `${SHEET_NAME}!B6:D48`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return 'No hay datos en el catálogo.';
    return rows
      .filter(row => row[0])
      .map(row => `- ${row[0]}${row[2] ? ': $' + row[2] : ''}`)
      .join('\n');
  } catch (error) {
    console.error('Error consultando Sheet:', error.message);
    return null;
  }
}

// Transcribir audio con Whisper
async function transcribirAudio(mediaUrl) {
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    // Descargar el audio con autenticación de Twilio
    const response = await fetch(mediaUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
        ).toString('base64')
      }
    });

    const buffer   = await response.buffer();
    const tmpPath  = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);

    const transcripcion = await openai.audio.transcriptions.create({
      file:     fs.createReadStream(tmpPath),
      model:    'whisper-1',
      language: 'es'
    });

    fs.unlinkSync(tmpPath);
    return transcripcion.text;

  } catch (error) {
    console.error('Error transcribiendo audio:', error.message);
    return null;
  }
}

const conversaciones = {};

const SYSTEM_PROMPT = `Sos el asistente virtual de Óptica Volpi. Tu rol es atender consultas de clientes por WhatsApp de forma amable, clara y concisa.

INFORMACIÓN DEL LOCAL:
- Nombre: Óptica Volpi
- Dirección: Avda. Congreso 2368
- Teléfono: 4563-1609
- Horario de atención: lunes a viernes de 10 a 20 hs

PRODUCTOS Y SERVICIOS:
- Anteojos de receta y de sol
- Lentes de contacto
- Soluciones para lentes de contacto

FORMAS DE PAGO:
- Si no sabés las formas de pago exactas, respondé: "Aceptamos efectivo y tarjetas. Para más detalles podés llamarnos al 4563-1609 o visitarnos en el local."

TURNOS:
- Los clientes pueden acercarse directamente al local en el horario de atención o llamar al 4563-1609 para coordinar.

REGLAS IMPORTANTES:
- Siempre respondé en español rioplatense (usá "vos" en lugar de "tú")
- Sé amable y breve — máximo 3 oraciones por respuesta
- Si no podés resolver algo, decí: "Para más información podés llamarnos al 4563-1609 o visitarnos en Avda. Congreso 2368 de 10 a 20 hs."
- Nunca inventes información que no tenés
- No hagas preguntas múltiples en una misma respuesta
- Cuando el catálogo esté disponible en el contexto, usalo para responder preguntas sobre marcas y precios`;

app.get('/', (req, res) => {
  res.send('Agente WhatsApp Óptica Volpi activo');
});

app.post('/webhook', async (req, res) => {
  const twiml      = new twilio.twiml.MessagingResponse();
  const remitente  = req.body.From || '';
  let   mensaje    = req.body.Body || '';

  try {
    // Si es un mensaje de voz, transcribir
    const numMedia = parseInt(req.body.NumMedia || '0');
    if (numMedia > 0 && req.body.MediaContentType0 && req.body.MediaContentType0.includes('audio')) {
      const audioUrl     = req.body.MediaUrl0;
      const transcripcion = await transcribirAudio(audioUrl);
      if (transcripcion) {
        mensaje = transcripcion;
      } else {
        twiml.message('No pude procesar tu mensaje de voz. ¿Podés escribirme?');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }
    }

    if (!mensaje.trim()) {
      twiml.message('No recibí ningún mensaje. ¿En qué te puedo ayudar?');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!conversaciones[remitente]) {
      conversaciones[remitente] = [
        { role: 'system', content: SYSTEM_PROMPT }
      ];
    }

    const preguntaCatalogo = /marca|precio|anteojos|modelo|tienen|ray.ban|oakley|prada|gucci|armani|cuánto|cuanto/i.test(mensaje);
    if (preguntaCatalogo) {
      const catalogo = await consultarCatalogo();
      if (catalogo) {
        conversaciones[remitente].push({
          role:    'system',
          content: `Catálogo actualizado de marcas y precios:\n${catalogo}`
        });
      }
    }

    conversaciones[remitente].push({ role: 'user', content: mensaje });

    if (conversaciones[remitente].length > 21) {
      conversaciones[remitente] = [
        conversaciones[remitente][0],
        ...conversaciones[remitente].slice(-20)
      ];
    }

    const completion = await openai.chat.completions.create({
      model:      'gpt-4o-mini',
      messages:   conversaciones[remitente],
      max_tokens: 300
    });

    const respuesta = completion.choices[0].message.content;
    conversaciones[remitente].push({ role: 'assistant', content: respuesta });

    twiml.message(respuesta);

  } catch (error) {
    console.error('Error:', error.message);
    twiml.message('Hubo un error procesando tu mensaje. Por favor intentá de nuevo.');
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
