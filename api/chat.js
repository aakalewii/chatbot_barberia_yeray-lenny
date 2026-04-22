import { google } from "googleapis";

const BASE_SYSTEM_PROMPT = `Eres el asistente virtual de Nández Studio Maspalomas, una barbería premium en Gran Canaria. Respondes por WhatsApp de forma cercana y breve. Tuteas al cliente.

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
Después del JSON, escribe el mensaje normal de confirmación al cliente.
13. Si el cliente quiere MODIFICAR una cita existente, usa este formato EXACTAMENTE antes del mensaje al cliente:
[MODIFICAR]{"evento_id":"...","servicio":"...","barbero":"...","fecha":"YYYY-MM-DD","hora_inicio":"HH:MM","hora_fin":"HH:MM"}[/MODIFICAR]
Después del JSON, escribe el mensaje normal de confirmación al cliente.`;

function buildSystemPrompt() {
  const now = new Date().toLocaleDateString("es-ES", {
    timeZone: "Atlantic/Canary",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Hoy es ${now}. El horario de la barbería es Lunes-Viernes 10:00-20:00 y Sábados 10:00-14:00. Nunca agendes citas fuera de ese horario ni en domingo.\n\n${BASE_SYSTEM_PROMPT}`;
}

function initCalendar() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

// Converts a Canary Islands local datetime string to a UTC Date object.
// Needed because Vercel runs on UTC and the Calendar API expects ISO strings.
function canaryToUTC(fecha, hora) {
  const dummy = new Date(`${fecha}T${hora}:00Z`);
  const canaryTime = new Date(dummy.toLocaleString("en-US", { timeZone: "Atlantic/Canary" }));
  const utcTime = new Date(dummy.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = utcTime.getTime() - canaryTime.getTime();
  return new Date(dummy.getTime() + offsetMs);
}

function getBusinessHours(fecha) {
  const weekday = new Date(`${fecha}T12:00:00Z`)
    .toLocaleDateString("es-ES", { timeZone: "Atlantic/Canary", weekday: "long" })
    .toLowerCase();
  if (weekday === "domingo") return null;
  if (weekday === "sábado") return { open: "10:00", close: "14:00" };
  return { open: "10:00", close: "20:00" };
}

function slotMinutes(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

function minutesToSlot(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseClaudeResponse(rawText) {
  const reservaMatch = rawText.match(/\[RESERVA\](\{.*?\})\[\/RESERVA\]/s);
  if (reservaMatch) {
    try {
      const datos = JSON.parse(reservaMatch[1]);
      const reply = rawText.replace(reservaMatch[0], "").trim();
      return { tipo: "nueva", datos, reply };
    } catch {
      return { tipo: null, datos: null, reply: rawText.replace(reservaMatch[0], "").trim() };
    }
  }

  const modificarMatch = rawText.match(/\[MODIFICAR\](\{.*?\})\[\/MODIFICAR\]/s);
  if (modificarMatch) {
    try {
      const datos = JSON.parse(modificarMatch[1]);
      const reply = rawText.replace(modificarMatch[0], "").trim();
      return { tipo: "modificar", datos, reply };
    } catch {
      return { tipo: null, datos: null, reply: rawText.replace(modificarMatch[0], "").trim() };
    }
  }

  return { tipo: null, datos: null, reply: rawText.trim() };
}

async function checkAvailability(calendar, fecha, horaInicio, horaFin) {
  const timeMin = canaryToUTC(fecha, horaInicio).toISOString();
  const timeMax = canaryToUTC(fecha, horaFin).toISOString();

  const result = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
  });

  return (result.data.items || []).length === 0;
}

async function findNextAvailableSlot(calendar, fecha, horaInicio, duracionMinutos) {
  const hours = getBusinessHours(fecha);
  if (!hours) return null;

  const closeMinutes = slotMinutes(hours.close);
  let cursor = slotMinutes(horaInicio) + duracionMinutos;

  while (cursor + duracionMinutos <= closeMinutes) {
    const slotStart = minutesToSlot(cursor);
    const slotEnd = minutesToSlot(cursor + duracionMinutos);
    const libre = await checkAvailability(calendar, fecha, slotStart, slotEnd);
    if (libre) return slotStart;
    cursor += 30;
  }

  return null;
}

async function insertCalendarEvent(calendar, reserva) {
  const result = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `${reserva.servicio} - ${reserva.nombre_cliente}`,
      description: `Barbero: ${reserva.barbero}`,
      start: { dateTime: `${reserva.fecha}T${reserva.hora_inicio}:00`, timeZone: "Atlantic/Canary" },
      end: { dateTime: `${reserva.fecha}T${reserva.hora_fin}:00`, timeZone: "Atlantic/Canary" },
    },
  });
  return result.data.id;
}

async function updateCalendarEvent(calendar, modificar) {
  await calendar.events.update({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: modificar.evento_id,
    requestBody: {
      summary: modificar.servicio,
      description: `Barbero: ${modificar.barbero}`,
      start: { dateTime: `${modificar.fecha}T${modificar.hora_inicio}:00`, timeZone: "Atlantic/Canary" },
      end: { dateTime: `${modificar.fecha}T${modificar.hora_fin}:00`, timeZone: "Atlantic/Canary" },
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
        system: buildSystemPrompt(),
        messages,
      }),
    });

    const data = await response.json();
    const rawText = data.content?.[0]?.text || "Perdona, no he podido procesar tu mensaje.";
    const { tipo, datos, reply } = parseClaudeResponse(rawText);

    if (tipo === "nueva" && calendar) {
      try {
        const duracion = slotMinutes(datos.hora_fin) - slotMinutes(datos.hora_inicio);
        const libre = await checkAvailability(calendar, datos.fecha, datos.hora_inicio, datos.hora_fin);

        if (!libre) {
          const nextSlot = await findNextAvailableSlot(calendar, datos.fecha, datos.hora_inicio, duracion);
          const sugerencia = nextSlot
            ? `¿Te viene bien a las ${nextSlot}?`
            : "¿Qué otro día o hora te viene bien?";
          return res.status(200).json({
            reply: `Lo siento tío, ese hueco ya está pillado 😅 ${sugerencia}`,
          });
        }

        const eventoId = await insertCalendarEvent(calendar, datos);
        console.log("Evento creado en Google Calendar:", eventoId, datos);
        return res.status(200).json({
          reply,
          evento_id: eventoId,
          sistema: `[SISTEMA: La última cita tiene evento_id: ${eventoId}]`,
        });
      } catch (calendarError) {
        console.error("Error al gestionar evento en Google Calendar:", calendarError);
      }
    }

    if (tipo === "modificar" && calendar) {
      try {
        const libre = await checkAvailability(calendar, datos.fecha, datos.hora_inicio, datos.hora_fin);

        if (!libre) {
          const duracion = slotMinutes(datos.hora_fin) - slotMinutes(datos.hora_inicio);
          const nextSlot = await findNextAvailableSlot(calendar, datos.fecha, datos.hora_inicio, duracion);
          const sugerencia = nextSlot
            ? `¿Te viene bien a las ${nextSlot}?`
            : "¿Qué otro día o hora te viene bien?";
          return res.status(200).json({
            reply: `Lo siento tío, ese hueco ya está pillado 😅 ${sugerencia}`,
          });
        }

        await updateCalendarEvent(calendar, datos);
        console.log("Evento modificado en Google Calendar:", datos.evento_id);
      } catch (calendarError) {
        console.error("Error al modificar evento en Google Calendar:", calendarError);
      }
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Error al conectar con Anthropic:", err);
    return res.status(500).json({ error: "Error al conectar con el asistente." });
  }
}
