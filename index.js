const express    = require('express');
const { OpenAI } = require('openai');
const twilio     = require('twilio');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Historial de conversaciones por número de WhatsApp
const conversaciones = {};

// System prompt del agente — editalo a tu gusto
const SYSTEM_PROMPT = `Sos un asistente virtual del consultorio oftalmológico. 
Respondés preguntas frecuentes, informás horarios y contacto, y ayudás a los pacientes. 
Siempre respondés en español, de forma amable y concisa.
Si no podés resolver algo, indicá que un humano se va a comunicar a la brevedad.`;

app.get('/', (req, res) => {
  res.send('Agente WhatsApp activo');
});

app.post('/webhook', async (req, res) => {
  const twiml      = new twilio.twiml.MessagingResponse();
  const mensaje    = req.body.Body || '';
  const remitente  = req.body.From || '';

  try {
    // Inicializar historial si no existe
    if (!conversaciones[remitente]) {
      conversaciones[remitente] = [
        { role: 'system', content: SYSTEM_PROMPT }
      ];
    }

    // Agregar mensaje del usuario al historial
    conversaciones[remitente].push({ role: 'user', content: mensaje });

    // Limitar historial a últimos 20 mensajes para no exceder tokens
    if (conversaciones[remitente].length > 21) {
      conversaciones[remitente] = [
        conversaciones[remitente][0],               // mantener system prompt
        ...conversaciones[remitente].slice(-20)     // últimos 20 mensajes
      ];
    }

    // Llamar a GPT-4
    const completion = await openai.chat.completions.create({
      model:    'gpt-4o-mini',  // más económico, cambiá a 'gpt-4' si preferís
      messages: conversaciones[remitente],
      max_tokens: 500
    });

    const respuesta = completion.choices[0].message.content;

    // Guardar respuesta en historial
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
