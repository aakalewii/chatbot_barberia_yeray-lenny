import { google } from "googleapis";

const TODOS_BARBEROS = ["Kevin Clavijo", "Manuel Colmenares", "Nández", "David Castro"];

const BASE_SYSTEM_PROMPT = `Eres el asistente virtual de Nández Studio Maspalomas, una barbería premium en Gran Canaria. Respondes por WhatsApp de forma cercana y breve. Tuteas al cliente.

DATOS DE LA BARBERÍA:
- Nombre: Nández Studio Maspalomas
- Dirección: Avenida de Gáldar, 70, 35100, San Bartolomé de Tirajana (Gran Canaria)
- Teléfono: 641 87 84 76
- Valoración: 4.9 estrellas (172 reseñas en Booksy)
- Instagram: @nandezstudio

BARBEROS: Kevin Clavijo, Manuel Colmenares, Nández, David Castro

HORARIO:
- Lunes a Viernes: 10:00 - 20:00
- Sábados: 10:00 - 14:00
- Domingos: Cerrado

ESTILO Y TONO:
- Responde SIEMPRE en español
- Sé breve y directo (máximo 3-4 líneas por mensaje)
- Tono de colega joven pero educado. Usa "tío", "bro", "crack" de vez en cuando pero sin forzar. Nada de "estimado cliente" ni formalidades. Eres cercano pero nunca maleducado ni pasota.
- Si saludan, preséntate: "¡Ey! Qué tal 👋 Soy el asistente de Nández Studio 💈"
- Usa emojis con naturalidad (1-2 por mensaje). No abuses.
- Si alguien pregunta algo gracioso o informal, sigue el rollo brevemente pero redirige a ayudarle.
- Si preguntan algo que no sabes, di que lo consultas con el equipo y responden enseguida.
- No inventes servicios ni precios que no estén en la lista.

FLUJO OBLIGATORIO:
1. Al saludar, pregunta únicamente: "¿A qué hora quieres venir y qué día?"
2. NO ofrezcas servicios hasta que la disponibilidad esté confirmada
3. NO sugieras horas. Espera siempre a que el cliente proponga la suya
4. Cuando el cliente diga la hora, genera [CONSULTAR_HORA] para verificar disponibilidad. La hora_fin es siempre hora_inicio + 30 minutos.
5. Una vez confirmada disponibilidad, el sistema te dirá qué barberos están libres — preséntaselos al cliente
6. Cuando el cliente elija barbero, presenta los servicios:
   - Corte de cabello: 13,99€ (30 min)
   - Corte de cabello & Barba: 17,99€ (30 min)
   - Decoloración completa & Corte: 54,99€ (30 min)
7. Cuando el cliente elija servicio, pide su nombre: "¿Y cómo te llamo para la reserva?"
8. Cuando tengas el nombre del cliente, genera [RESERVA] para confirmar

REGLAS ESTRICTAS:
1. Nunca saltes pasos. El orden es: hora → barbero → servicio → nombre → confirmación. Siempre.
2. Si el cliente mezcla información de pasos distintos en un mismo mensaje (por ejemplo dice la hora y el servicio a la vez), recoge solo el dato del paso actual e ignora el resto hasta llegar a ese paso.
3. Si en algún momento no tienes claro qué paso toca, vuelve al último dato que falta y pregúntalo.
4. Nunca confirmes una reserva sin tener los 4 datos: hora, barbero, servicio y nombre del cliente.
5. Antes de generar el bloque [RESERVA], SIEMPRE pide el nombre del cliente si no lo sabes todavía. Nunca generes [RESERVA] sin tener el nombre del cliente confirmado.
6. El nombre del cliente y el nombre del barbero son dos datos completamente separados. El barbero se elige en el paso de disponibilidad. El nombre del cliente se recoge en el paso final antes de confirmar. Nunca uses el nombre del cliente como si fuera un barbero ni viceversa.

FORMATOS DE RESPUESTA (uso exclusivo del servidor — nunca los muestres al cliente tal cual):

Consulta de disponibilidad — colócalo ANTES del mensaje al cliente:
[CONSULTAR_HORA]{"fecha":"YYYY-MM-DD","hora_inicio":"HH:MM","hora_fin":"HH:MM"}[/CONSULTAR_HORA]

Reserva nueva — colócalo ANTES del mensaje de confirmación al cliente:
[RESERVA]{"servicio":"...","barbero":"...","fecha":"YYYY-MM-DD","hora_inicio":"HH:MM","hora_fin":"HH:MM","nombre_cliente":"..."}[/RESERVA]

Modificar cita existente — colócalo ANTES del mensaje de confirmación al cliente:
[MODIFICAR]{"evento_id":"...","servicio":"...","barbero":"...","fecha":"YYYY-MM-DD","hora_inicio":"HH:MM","hora_fin":"HH:MM"}[/MODIFICAR]`;

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

// Converts a Canary Islands local datetime to UTC.
// Required because Vercel runs on UTC and the Calendar API expects ISO strings.
function canaryToUTC(fecha, hora) {
  const dummy = new Date(`${fecha}T${hora}:00Z`);
  const canaryTime = new Date(dummy.toLocaleString("en-US", { timeZone: "Atlantic/Canary" }));
  const utcTime = new Date(dummy.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(dummy.getTime() + (utcTime.getTime() - canaryTime.getTime()));
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
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseClaudeResponse(rawText) {
  for (const [tag, tipo] of [["CONSULTAR_HORA", "consultar_hora"], ["RESERVA", "nueva"], ["MODIFICAR", "modificar"]]) {
    const match = rawText.match(new RegExp(`\\[${tag}\\](\\{.*?\\})\\[\\/${tag}\\]`, "s"));
    if (match) {
      try {
        const datos = JSON.parse(match[1]);
        const reply = rawText.replace(match[0], "").trim();
        return { tipo, datos, reply };
      } catch {
        return { tipo: null, datos: null, reply: rawText.replace(match[0], "").trim() };
      }
    }
  }
  return { tipo: null, datos: null, reply: rawText.trim() };
}

async function getBarberosDisponibles(calendar, fecha, horaInicio, horaFin) {
  const result = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: canaryToUTC(fecha, horaInicio).toISOString(),
    timeMax: canaryToUTC(fecha, horaFin).toISOString(),
    singleEvents: true,
  });

  const ocupados = new Set(
    (result.data.items || [])
      .map((e) => (e.description || "").match(/^Barbero:\s*(.+)$/m)?.[1]?.trim())
      .filter(Boolean)
  );

  return TODOS_BARBEROS.filter((b) => !ocupados.has(b));
}

async function checkAvailability(calendar, fecha, horaInicio, horaFin) {
  const libres = await getBarberosDisponibles(calendar, fecha, horaInicio, horaFin);
  return libres.length === TODOS_BARBEROS.length; // true solo si todos están libres
}

async function findNextAvailableSlot(calendar, fecha, horaInicio, duracionMinutos) {
  const hours = getBusinessHours(fecha);
  if (!hours) return null;

  const closeMinutes = slotMinutes(hours.close);
  let cursor = slotMinutes(horaInicio) + duracionMinutos;

  while (cursor + duracionMinutos <= closeMinutes) {
    const slotStart = minutesToSlot(cursor);
    const slotEnd = minutesToSlot(cursor + duracionMinutos);
    const libres = await getBarberosDisponibles(calendar, fecha, slotStart, slotEnd);
    if (libres.length > 0) return slotStart;
    cursor += 30;
  }

  return null;
}

async function insertCalendarEvent(calendar, reserva) {
  const summary = reserva.nombre_cliente
    ? `${reserva.servicio} - ${reserva.nombre_cliente}`
    : reserva.servicio;

  const result = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary,
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

    // --- CONSULTAR_HORA: consulta real de disponibilidad por barbero ---
    if (tipo === "consultar_hora" && calendar) {
      try {
        const libres = await getBarberosDisponibles(calendar, datos.fecha, datos.hora_inicio, datos.hora_fin);

        if (libres.length === 0) {
          return res.status(200).json({
            reply: "Lo siento tío, esa hora está petada 😅 ¿Tienes otro horario?",
          });
        }

        const lista = libres.join(", ");
        return res.status(200).json({
          reply: `Tenemos hueco 💈 A esa hora están disponibles: ${lista}. ¿Con cuál prefieres?`,
          sistema: `[SISTEMA: Barberos disponibles a esa hora: ${lista}]`,
        });
      } catch (calendarError) {
        console.error("Error al consultar disponibilidad:", calendarError);
        // Si Calendar falla, devuelve la respuesta de Claude sin el bloque
      }
    }

    // --- RESERVA nueva ---
    if (tipo === "nueva" && calendar) {
      try {
        if (!TODOS_BARBEROS.includes(datos.barbero)) {
          return res.status(200).json({
            reply: "Perdona, ha habido un lío con el barbero. ¿Me confirmas con cuál quedamos? Tenemos a Kevin Clavijo, Manuel Colmenares, Nández y David Castro.",
          });
        }

        const duracion = slotMinutes(datos.hora_fin) - slotMinutes(datos.hora_inicio);
        const libres = await getBarberosDisponibles(calendar, datos.fecha, datos.hora_inicio, datos.hora_fin);

        if (!libres.includes(datos.barbero)) {
          const nextSlot = await findNextAvailableSlot(calendar, datos.fecha, datos.hora_inicio, duracion);
          const sugerencia = nextSlot
            ? `¿Te viene bien a las ${nextSlot}?`
            : "¿Qué otro horario te viene bien?";
          return res.status(200).json({
            reply: `Lo siento tío, ese hueco ya está pillado 😅 ${sugerencia}`,
          });
        }

        const eventoId = await insertCalendarEvent(calendar, datos);
        console.log("Evento creado:", eventoId, datos);
        return res.status(200).json({
          reply,
          evento_id: eventoId,
          sistema: `[SISTEMA: La última cita tiene evento_id: ${eventoId}]`,
        });
      } catch (calendarError) {
        console.error("Error al insertar evento:", calendarError);
      }
    }

    // --- MODIFICAR cita existente ---
    if (tipo === "modificar" && calendar) {
      try {
        if (!TODOS_BARBEROS.includes(datos.barbero)) {
          return res.status(200).json({
            reply: "Perdona, ha habido un lío con el barbero. ¿Me confirmas con cuál quedamos? Tenemos a Kevin Clavijo, Manuel Colmenares, Nández y David Castro.",
          });
        }

        const libres = await getBarberosDisponibles(calendar, datos.fecha, datos.hora_inicio, datos.hora_fin);

        if (!libres.includes(datos.barbero)) {
          const duracion = slotMinutes(datos.hora_fin) - slotMinutes(datos.hora_inicio);
          const nextSlot = await findNextAvailableSlot(calendar, datos.fecha, datos.hora_inicio, duracion);
          const sugerencia = nextSlot
            ? `¿Te viene bien a las ${nextSlot}?`
            : "¿Qué otro horario te viene bien?";
          return res.status(200).json({
            reply: `Lo siento tío, ese hueco ya está pillado 😅 ${sugerencia}`,
          });
        }

        await updateCalendarEvent(calendar, datos);
        console.log("Evento modificado:", datos.evento_id);
      } catch (calendarError) {
        console.error("Error al modificar evento:", calendarError);
      }
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Error al conectar con Anthropic:", err);
    return res.status(500).json({ error: "Error al conectar con el asistente." });
  }
}
