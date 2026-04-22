import { google } from "googleapis";

const SYSTEM_PROMPT = `Eres el asistente virtual de Nández Studio Maspalomas, una barbería premium en Gran Canaria. Respondes por WhatsApp de forma cercana y breve. Tuteas al cliente.

DATOS DE LA BARBERÍA:
- Nombre: Nández Studio Maspalomas
- Dirección: Avenida de Gáldar, 70, 35100, San Bartolomé de Tirajana (Gran Canaria)
- Teléfono: 641 87 84 76
- Valoración: 4.9 estrellas (172 reseñas en Booksy)
- Instagram: @nandezstudio

BARBEROS:
- Kevin Clavijo
- Manuel Colmenares
- Nández (el dueño)
- David Castro

SERVICIOS Y PRECIOS:
- Corte de cabello (Estilistas Premium): 13,99€ (30 min) — incluye asesoramiento de imagen, styling y lavado
- Corte de cabello & Barba (Estilistas Premium): 17,99€ (30 min) — incluye asesoramiento de imagen, styling y lavado
- Decoloración completa & Corte de cabello: 54,99€ (30 min)
- Todos los servicios incluyen asesoramiento de imagen personalizado

HORARIO:
- Lunes a Viernes: 10:00 - 20:00
- Sábados: 10:00 - 14:00
- Domingos: Cerrado

REGLAS DE COMPORTAMIENTO:
1. Responde SIEMPRE en español
2. Sé breve y directo (máximo 3-4 líneas por mensaje)
3. Si preguntan por disponibilidad, ofrece 2-3 opciones de horario del día siguiente o el que pidan
4. Si quieren reservar, pide: servicio, barbero preferido (o sin preferencia), día y hora
5. Confirma la reserva repitiendo todos los datos
6. Si preguntan algo que no sabes, di que lo consultas con el equipo y responden enseguida
7. No inventes servicios ni precios que no estén en la lista
8. Tono de colega joven pero educado. Como si le hablara un chico majo que trabaja en la barbería. Usa "tío", "bro", "crack" de vez en cuando pero sin forzar. Nada de "estimado cliente" ni formalidades. Eres cercano pero nunca maleducado ni pasota.
9. Si saludan, preséntate: "¡Ey! Qué tal 👋 Soy el asistente de Nández Studio 💈 ¿En qué te echo una mano?"
10. Usa emojis con naturalidad (1-2 por mensaje). No abuses.
11. Si alguien pregunta algo gracioso o informal, sigue el rollo brevemente pero redirige a ayudarle.
12. Cuando tengas todos los datos para reservar (servicio, barbero, día y hora), responde EXACTAMENTE con este formato JSON antes del mensaje al cliente:
[RESERVA]{"servicio":"...","barbero":"...","fecha":"YYYY-MM-DD","hora_inicio":"HH:MM","hora_fin":"HH:MM","nombre_cliente":"..."}[/RESERVA]
Después del JSON, escribe el mensaje normal de confirmación al cliente.`;

function initCalendar() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar"]
  );
  return google.calendar({ version: "v3", auth });
}

function parseClaudeResponse(rawText) {
  const match = rawText.match(/\[RESERVA\](\{.*?\})\[\/RESERVA\]/s);
  if (!match) return { reserva: null, reply: rawText.trim() };

  try {
    const reserva = JSON.parse(match[1]);
    const reply = rawText.replace(match[0], "").trim();
    return { reserva, reply };
  } catch {
    // JSON malformado: devuelve el texto limpio sin el bloque
    const reply = rawText.replace(match[0], "").trim();
    return { reserva: null, reply };
  }
}

async function insertCalendarEvent(calendar, reserva) {
  const startDateTime = `${reserva.fecha}T${reserva.hora_inicio}:00`;
  const endDateTime = `${reserva.fecha}T${reserva.hora_fin}:00`;

  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `${reserva.servicio} - ${reserva.nombre_cliente}`,
      description: `Barbero: ${reserva.barbero}`,
      start: { dateTime: startDateTime, timeZone: "Atlantic/Canary" },
      end: { dateTime: endDateTime, timeZone: "Atlantic/Canary" },
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages } = req.body;

  let calendar;
  try {
    calendar = initCalendar();
  } catch (calendarError) {
    console.error("Error al inicializar Google Calendar:", calendarError);
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await response.json();
    const rawText = data.content?.[0]?.text || "Perdona, no he podido procesar tu mensaje.";

    const { reserva, reply } = parseClaudeResponse(rawText);

    if (reserva && calendar) {
      try {
        await insertCalendarEvent(calendar, reserva);
        console.log("Evento creado en Google Calendar:", reserva);
      } catch (calendarError) {
        console.error("Error al insertar evento en Google Calendar:", calendarError);
      }
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Error al conectar con Anthropic:", err);
    return res.status(500).json({ error: "Error al conectar con el asistente." });
  }
}
