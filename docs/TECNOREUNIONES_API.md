# Tecnoreuniones API Reference

> **Base URL:** `https://www.tecnoreuniones.com/vdev/tecnor2.php`
> **Protocol:** HTTP POST (form-encoded or query-string `$_REQUEST`)
> **Auth:** Token-based — pass `token` as a request parameter (not a Bearer header)
> **Internal Secret:** `CH253864` (used for admin login `pass` field)

---

## Table of Contents

1. [Authentication](#authentication)
2. [Assembly Management](#assembly-management)
3. [Attendance & Quorum](#attendance--quorum)
4. [Questions & Voting](#questions--voting)
5. [Delegation & Powers](#delegation--powers)
6. [User Management](#user-management)
7. [Data Model](#data-model)
8. [Robinson Integration Map](#robinson-integration-map)

---

## Authentication

### Service 1 — Admin Login

Authenticates an administrator and returns a session token + assembly ID.

| Param     | Type   | Description                    |
|-----------|--------|--------------------------------|
| `service` | `1`    | Service identifier             |
| `usuario` | string | Admin username                 |
| `pass`    | string | Password (shared secret)       |

**Token:** Can be empty for this service.

**Response (200):**
```json
[{
  "idAsamblea": 123,
  "token": "abc123..."
}]
```

**SQL:** Queries `administradores` table, inserts into `sesiones`.

---

### Service 1005 — User Login (Primary)

Full user authentication with three strategies (priority: QR → Token → Credentials).

| Param        | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `service`    | `1005` | Service identifier                       |
| `qr`         | string | (optional) QR card code                  |
| `token`      | string | (optional) Existing session token        |
| `idUsuario`  | string | (optional) User ID for credential auth   |
| `idAsamblea` | int    | (optional) Assembly ID for credential auth |
| `pass`       | string | (optional) Password for credential auth  |

**Token:** Can be empty for this service.

**Response (200):**
```json
[{
  "nombrePropietario1": "John",
  "nombrePropietario2": "Doe",
  "idUsuario": "L10",
  "idAsamblea": 123,
  "clave1": "...",
  "token": "new-token-abc...",
  "timestamp": 1720000000
}]
```

**Side effects:**
- Creates/updates `sesiones` record
- Registers attendance in `asistentes` table (tipoRepresentacion='P')
- Processes delegates (`asistentesdelegados` view → `asistentes`)
- Processes consolidated units (`residentes.agrupado`)
- Caches session in Redis (`token:{token}`, `user:{id}:{asamblea}`)

---

### Service 1006 — Retrieve Representation List

| Param   | Type   | Description          |
|---------|--------|----------------------|
| `service` | `1006` | Service identifier |
| `token` | string | Session token        |
| `pass`  | string | User password        |

**Response (200):** JSON with `nombrePropietario1`, `nombrePropietario2`, `token`.

---

## Assembly Management

### Service 1003 — Assembly Metadata

Returns metadata for a specific assembly.

| Param        | Type   | Description          |
|--------------|--------|----------------------|
| `service`    | `1003` | Service identifier   |
| `token`      | string | Session token        |
| `idAsamblea` | int    | Assembly ID          |

**Response (200):**
```json
[{
  "idAsamblea": 123,
  "cliente": "Edificio Las Palmas",
  "estado": "EN CURSO",
  "permiteRegistro": "S",
  "permiteVotoMora": "S",
  "logo": "logo.png",
  "muestraRespuesta": 0,
  ...
}]
```

**SQL:** `SELECT * FROM asambleas WHERE idAsamblea = ?`

---

### Service 7 — Change Assembly State

| Param              | Type   | Description                        |
|--------------------|--------|------------------------------------|
| `service`          | `7`    | Service identifier                 |
| `token`            | string | Session token                      |
| `estado`           | string | New state (e.g. "EN CURSO", "REGISTRO", "TERMINADA") |
| `permiteVotoMora`  | string | (optional) "S" or "N"              |

**Response:** 200 OK or 400 error.

---

### Service 8 — Administrator Info

| Param   | Type | Description        |
|---------|------|--------------------|
| `service` | `8` | Service identifier |
| `token` | string | Session token    |

**Response (200):**
```json
[{
  "nombreAdministrador": "Admin Name",
  "email": "admin@example.com"
}]
```

---

### Service 9 — List Active Assemblies

Returns assemblies with `estado IN ("EN CURSO", "REGISTRO")`. Cached in Redis for 30 seconds.

| Param   | Type | Description        |
|---------|------|--------------------|
| `service` | `9` | Service identifier |

**Token:** Can be empty for this service.

**Response (200):**
```json
[
  {"idAsamblea": 1, "cliente": "Edificio A", "logo": "logo1.png"},
  {"idAsamblea": 2, "cliente": "Edificio B", "logo": "tecnologo.png"}
]
```

---

### Service 1007 — Assembly Status (Quorum Dashboard)

Returns assembly status from `estadoasamblea` view. Cached in Redis for 5 seconds.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1007` | Service identifier |
| `token`      | string | Session token      |
| `idAsamblea` | int    | Assembly ID (also accepts `a` param) |

**Token:** Can be empty for this service.

**Response (200):** JSON array with assembly status data (quorum percentages, attendee counts, state, etc.).

**SQL:** `SELECT * FROM estadoasamblea WHERE idAsamblea = ?`

---

### Service 10 — Initialize Demo Assembly

Resets assembly ID 2 (demo) — clears votes, questions, delegates, attendees, sessions.

| Param   | Type  | Description        |
|---------|-------|--------------------|
| `service` | `10` | Service identifier |

**Response:** 204 No Content on success.

---

## Attendance & Quorum

### Service 3 — List Delegates (Attendance)

Returns the delegate/attendance list for an assembly.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `3`    | Service identifier |
| `token`      | string | Session token      |
| `idAsamblea` | int    | Assembly ID        |

**Response (200):** JSON array from `listadelegados` view.
```json
[
  {
    "idAsamblea": 123,
    "idtorre": "T1",
    "idunidad": "101",
    "nombrePropietario1": "John Doe",
    "nombrePropietario2": "Jane Doe",
    "coeficiente": 2.5,
    "tipoRepresentacion": "P",
    "fhultimoingreso": "2025-01-15 10:30:00",
    ...
  }
]
```

**SQL:** `SELECT * FROM listadelegados WHERE idAsamblea = ?`

---

### Service 1008 — Represented Units for User

Returns units represented by a logged-in user. Cached in Redis for 24 hours.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1008` | Service identifier |
| `token`      | string | Session token      |
| `idUsuario`  | string | User ID            |
| `idAsamblea` | int    | Assembly ID        |

**Response (200):** JSON array from `representados` view.

---

### Service 61 — Close Question & Save Quorum Snapshot

Closes the active question, saves a quorum snapshot with attendee list, and activates question 0 (default).

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `61`   | Service identifier |
| `token`      | string | Session token      |
| `idPregunta` | int    | Question ID to close |

**Response:** 200 "Ok" on success.

**Side effects:**
- Queries `asistentes` to calculate quorum (sum of coefficients)
- Inserts into `quorumRespuestas` with operacion='C', attendee count, quorum value, and full attendee list JSON
- Deactivates all questions, then activates question 0

---

### Service 62 — Get Quorum Snapshot for Question

| Param | Type | Description |
|-------|------|-------------|
| `service` | `62` | Service identifier |
| `a`   | int  | Assembly ID |
| `p`   | int  | Question ID |

**Response (200):**
```json
[{
  "quorum": 75.5,
  "asistentes": 42,
  "fhoperacion": "2025-01-15 11:00:00",
  "listaAsistentes": "[{...}]"
}]
```

**SQL:** `SELECT quorum, asistentes, fhoperacion, listaAsistentes FROM quorumRespuestas WHERE idAsamblea=? AND idPregunta=? ORDER BY fhoperacion DESC LIMIT 1`

---

## Questions & Voting

### Service 4 — Create Question

Creates a voting question with options.

| Param                | Type   | Description                  |
|----------------------|--------|------------------------------|
| `service`            | `4`    | Service identifier           |
| `token`              | string | Session token                |
| `idAsamblea`         | int    | Assembly ID                  |
| `encabezadoPregunta` | string | Question header/title        |
| `options`            | int    | Number of selectable options |
| `respuesta1`..`respuesta50` | string | Option texts (up to 50) |

**Response (200):** Returns the idPregunta of the newly created question.

**SQL:** Inserts into `preguntas` and `preguntasOpciones`.

---

### Service 5 — List Questions

Lists all questions for an assembly.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `5`    | Service identifier |
| `token`      | string | Session token      |

**Note:** `idAsamblea` is derived from the token validation.

**Response (200):**
```json
[
  {
    "idPregunta": 1,
    "idAsamblea": 123,
    "encabezadoPregunta": "¿Aprueba el presupuesto?",
    "activa": 0,
    "opciones": 1,
    ...
  }
]
```

**SQL:** `SELECT * FROM preguntas WHERE idAsamblea = ?`

---

### Service 6 — Activate Question

Activates a specific question for voting (deactivates all others first).

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `6`    | Service identifier |
| `token`      | string | Session token      |
| `idPregunta` | int    | Question to activate |

**Response:** 200 on success.

**Side effects:**
- Sets all questions `activa = 0`
- Sets target question `activa = 1`
- Updates `asambleas.muestraRespuesta` to the question ID

---

### Service 1002 — Voting Scrutiny (from View)

Returns voting results per question using the `escrutiniovotacion` view.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1002` | Service identifier |
| `token`      | string | Session token      |
| `idAsamblea` | int    | Assembly ID        |
| `idPregunta` | int    | Question ID        |

**Response (200):** JSON array from `escrutiniovotacion` view.

---

### Service 1010 — Get Active Question (Questionnaire)

Returns the currently active question for an assembly.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1010` | Service identifier |
| `token`      | string | Session token      |
| `idAsamblea` | int    | Assembly ID        |

**Response (200):** JSON array from `cuestionario` table. Empty `[{}]` if no active question.

---

### Service 1011 — Cast Vote (Single Choice)

Allows a user to cast a vote on an active question.

| Param        | Type   | Description          |
|--------------|--------|----------------------|
| `service`    | `1011` | Service identifier   |
| `token`      | string | Session token        |
| `idAsamblea` | int    | Assembly ID          |
| `idUsuario`  | string | User ID              |
| `idPregunta` | int    | Question ID          |
| `idTorre`    | string | Tower ID             |
| `idUnidad`   | string | Unit ID              |
| `respuesta`  | string | Response text        |

**Response:** 200 with the response text, or error if question closed.

**SQL:** `INSERT INTO respuestas ... ON DUPLICATE KEY UPDATE`

---

### Service 1022 — Cast Vote (Multiple Choice)

Allows a user to add/remove a vote for multi-select questions.

| Param           | Type   | Description                    |
|-----------------|--------|--------------------------------|
| `service`       | `1022` | Service identifier             |
| `token`         | string | Session token                  |
| `idAsamblea`    | int    | Assembly ID                    |
| `idUsuario`     | string | User ID                        |
| `idPregunta`    | int    | Question ID                    |
| `idTorre`       | string | Tower ID                       |
| `idUnidad`      | string | Unit ID                        |
| `respuesta`     | string | Response text                  |
| `estado`        | int    | 1 = add vote, 0 = remove vote |
| `seleccionados` | int    | Number of currently selected options |

**Response:** 200 with the response text.

**SQL:** Inserts/deletes from `respuestasmultiples`.

---

### Service 1032 — Cast Vote (Unified, Queue-based)

Modern replacement for services 1011 and 1022. Pushes votes to Redis queue.

| Param        | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `service`    | `1032` | Service identifier                       |
| `token`      | string | Session token                            |
| `idAsamblea` | int    | Assembly ID                              |
| `idUsuario`  | string | User ID                                  |
| `idPregunta` | int    | Question ID                              |
| `idTorre`    | string | Tower ID                                 |
| `idUnidad`   | string | Unit ID                                  |
| `respuestas` | string | URL-encoded JSON array of vote texts     |
| `opciones`   | int    | Number of selectable options             |

**Response:** `{"status": "OK"}` — votes processed asynchronously via Redis queue `voting_queue`.

---

### Service 10322 — Cast Vote (Unified, Synchronous)

Same as 1032 but processes votes synchronously with database transactions.

| Param        | Type   | Description                               |
|--------------|--------|-------------------------------------------|
| `service`    | `10322`| Service identifier                        |
| `token`      | string | Session token                             |
| `idAsamblea` | int    | Assembly ID                               |
| `idUsuario`  | string | User ID                                   |
| `idPregunta` | int    | Question ID                               |
| `idTorre`    | string | Tower ID                                  |
| `idUnidad`   | string | Unit ID                                   |
| `respuestas` | string | URL-encoded JSON array of vote texts      |
| `opciones`   | int    | 1 = single choice, >1 = multiple choice   |

**Logic:**
- If `opciones == 1` → inserts into `respuestas` table (ON DUPLICATE KEY UPDATE)
- If `opciones > 1` → inserts into `respuestasmultiples` table (prepared statements + transaction)
- Updates `asistentes.ultimarespuesta` to track last answered question

---

### Service 1012 — Voting Results (Aggregated)

Returns aggregated voting results with coefficient and nominal totals. Cached in Redis for 5 seconds.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1012` | Service identifier |
| `idAsamblea` | int    | Assembly ID        |
| `idPregunta` | int    | Question ID        |
| `opciones`   | int    | 1 = single, >1 = multiple (determines which table to query) |

**Response (200):**
```json
[
  {"texto": "A favor", "conteo": 25, "nominal": 25, "coeficiente": 55.3},
  {"texto": "En contra", "conteo": 10, "nominal": 10, "coeficiente": 22.1}
]
```

**SQL:** Joins `respuestas`/`respuestasmultiples` with `residentes` for coefficient data.

---

### Service 1025 — Check if Unit Already Voted

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1025` | Service identifier |
| `idAsamblea` | int    | Assembly ID        |
| `idtorre`    | string | Tower ID           |
| `idunidad`   | string | Unit ID            |
| `idPregunta` | int    | Question ID        |

**Response (200):**
```json
[{"yavoto": "S"}]   // or [{"yavoto": "N"}]
```

---

## Delegation & Powers

### Service 2 — Grant Power (Delegation)

Registers a delegation of voting power from one unit to another.

| Param        | Type   | Description          |
|--------------|--------|----------------------|
| `service`    | `2`    | Service identifier   |
| `token`      | string | Session token        |
| `idAsamblea` | int    | Assembly ID          |
| `idDelegante`| string | Granting user ID     |
| `idDelegado` | string | Receiving user ID    |

**Response:** 200 on success.

**SQL:** `INSERT INTO delegados (idAsamblea, idDelegante, idDelegado) ...`

---

### Service 1015 — Revoke Power (Delegation)

Revokes a previously granted delegation.

| Param        | Type   | Description          |
|--------------|--------|----------------------|
| `service`    | `1015` | Service identifier   |
| `token`      | string | Session token        |
| `idAsamblea` | int    | Assembly ID          |
| `idUnidad`   | string | Granting unit (delegante) |

**Response:** 200 "OK revocado" on success.

**Side effects:**
- Deletes delegate attendance records (`asistentes` where tipoRepresentacion='D')
- Deletes from `delegados` table
- Invalidates Redis caches for both users

---

### Service 1013 — Register Power of Representation

Registers powers of representation between units in the same group.

| Param                | Type   | Description         |
|----------------------|--------|---------------------|
| `service`            | `1013` | Service identifier  |
| `idAsamblea`         | int    | Assembly ID         |
| `idTorreOtorgante`   | string | Granting tower      |
| `idUnidadOtorgante`  | string | Granting unit       |
| `idTorreApoderada`   | string | Receiving tower     |
| `idUnidadApoderada`  | string | Receiving unit      |

**SQL:** `INSERT INTO poderes ...`

---

### Service 1014 — Query Powers by Grantor

Returns powers granted by a specific unit.

| Param                | Type   | Description         |
|----------------------|--------|---------------------|
| `service`            | `1014` | Service identifier  |
| `idAsamblea`         | int    | Assembly ID         |
| `idTorre`            | string | Tower ID            |
| `idUnidad`           | string | Unit ID             |

**Response (200):** JSON array with power records joined with resident data.

---

### Service 1009 — Remove Delegate Attendance

Removes delegate attendance records for a user.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `1009` | Service identifier |
| `token`      | string | Session token      |
| `idUsuario`  | string | User ID            |
| `idAsamblea` | int    | Assembly ID        |

**SQL:** `DELETE FROM asistentes WHERE ... AND tipoRepresentacion='D'`

---

## User Management

### Service 200 — Get User Info

Returns resident information for a specific user.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `200`  | Service identifier |
| `idAsamblea` | int    | Assembly ID        |
| `searchUser` | string | User ID to search  |

**Response (200):** Full row from `residentes` table.

---

### Service 201 — Update User Info

Updates resident information.

| Param                 | Type   | Description         |
|-----------------------|--------|---------------------|
| `service`             | `201`  | Service identifier  |
| `idAsamblea`          | int    | Assembly ID         |
| `searchUser`          | string | User ID to update   |
| `nombrePropietario1`  | string | Owner name 1        |
| `nombrePropietario2`  | string | Owner name 2        |
| `email1`              | string | Email 1             |
| `email2`              | string | Email 2             |
| `telefono1`           | string | Phone 1             |
| `telefono2`           | string | Phone 2             |
| `coeficiente`         | float  | Coefficient         |
| `nominal`             | float  | Nominal value       |
| `mora`                | string | In arrears ("S"/"N")|
| `clave`               | string | Password            |

---

### Service 202 — Reset User Session

Deletes the session and invalidates Redis caches for a user.

| Param        | Type   | Description        |
|--------------|--------|--------------------|
| `service`    | `202`  | Service identifier |
| `idAsamblea` | int    | Assembly ID        |
| `searchUser` | string | User ID            |

---

## Data Model

### Key Tables

| Table                  | Description                                           |
|------------------------|-------------------------------------------------------|
| `asambleas`            | Assembly/event master data (state, client, config)    |
| `residentes`           | Unit owners/residents with coefficients               |
| `administradores`      | Assembly administrators                               |
| `sesiones`             | Active sessions (token, userId, assemblyId, IP)       |
| `asistentes`           | Registered attendees (tipoRepresentacion: P/D/C)      |
| `delegados`            | Delegation relationships (delegante → delegado)       |
| `preguntas`            | Voting questions (activa flag)                        |
| `preguntasOpciones`    | Question option texts                                 |
| `respuestas`           | Single-choice votes                                   |
| `respuestasmultiples`  | Multi-choice votes                                    |
| `poderes`              | Power of representation between units                 |
| `quorumRespuestas`     | Quorum snapshots at question close time               |
| `qrcards`              | QR code → user mapping                               |
| `logSesiones`          | Session log                                           |

### Key Views

| View                  | Description                                            |
|-----------------------|--------------------------------------------------------|
| `listadelegados`      | Attendance list with delegation info (service 3)       |
| `escrutiniovotacion`  | Voting scrutiny per question (service 1002)            |
| `estadoasamblea`      | Assembly status dashboard (service 1007)               |
| `representados`       | Represented units per user (service 1008)              |
| `asistentesdelegados` | Delegate attendance records (internal)                 |
| `cuestionario`        | Active questionnaire view (service 1010)               |

### tipoRepresentacion Values

| Value | Meaning                                          |
|-------|--------------------------------------------------|
| `P`   | Present (owner attending directly)               |
| `D`   | Delegate (attending on behalf of another unit)   |
| `C`   | Consolidated (grouped unit)                      |

---

## Consolidated Results Endpoint (resultsdata.php)

> **RECOMMENDED** for fetching voting results — returns all data in a single call
> instead of requiring multiple service calls.

### URL

```
GET https://www.tecnoreuniones.com/vdev/resultsdata.php?a={idAsamblea}&p={idPregunta}&t={token}
```

### Parameters

| Param | Type   | Required | Description                                                    |
|-------|--------|----------|----------------------------------------------------------------|
| `a`   | int    | Yes      | Assembly ID (e.g. `25005`)                                     |
| `p`   | int    | No       | Question ID. If omitted, returns the active question or the last question |
| `t`   | string | Yes      | Server token: **`CH253864`**                                   |

### Response (JSON object — NOT an array)

```json
{
  "asamblea": {
    "idAsamblea": 25005,
    "cliente": "Portal de Valparaíso",
    "nombreAsamblea": "Asamblea General Ordinaria",
    "logo": "logo.png",
    "estado": "EN CURSO",
    ...
  },
  "pregunta": {
    "idPregunta": 3,
    "encabezadoPregunta": "¿Aprueba el presupuesto 2026?",
    "activa": "0",
    "opciones": "1",
    ...
  },
  "quorum": {
    "quorum": "86.07",
    "asistentes": 176,
    "totalNominal": "176.00"
  },
  "consolidado": [
    {"texto": "SI", "nominal": "150.00", "coeficiente": "73.25", "pquorum": "85.11"},
    {"texto": "NO", "nominal": "20.00", "coeficiente": "10.50", "pquorum": "12.20"},
    {"texto": "EN BLANCO", "nominal": "6.00", "coeficiente": "2.32", "pquorum": "2.70"}
  ],
  "detallado": [
    {
      "Torre": "5",
      "Unidad": "302",
      "Propietarios": "HERNÁN TIBERIO CORREA MORENO",
      "Respuesta": "SI",
      "coeficiente": "0.4831",
      "nominal": "1.00",
      "FechaHora": "2026-03-01 10:15:23",
      "ip": "192.168.1.50"
    }
  ],
  "novotan": [
    {"unidad": "5-401", "Propietario": "JUAN PÉREZ", "coeficiente": "0.3200"}
  ],
  "snapshot": {
    "quorum": 86.07,
    "asistentes": 176,
    "fhoperacion": "2026-03-01 12:30:00",
    "listaAsistentes": "[{...}]"
  }
}
```

### Key behavior

- **`consolidado`**: Aggregated by response text. For `opciones=1` queries `respuestas` table; for `opciones>1` queries `respuestasmultiples` table.
- **`detallado`**: Every individual vote with tower, unit, owner name, response, coefficient, nominal, timestamp, and IP. Same single/multiple table branching.
- **`novotan`**: Attendees who have NOT voted on this question. For active questions, uses live `asistentes` table. For closed questions, reconstructs from `quorumRespuestas` snapshot.
- **`snapshot`**: Only present when the question is closed (`activa=0`). Contains the quorum frozen at close time with the full attendee list JSON.

### Advantages over individual service calls

This endpoint replaces the need to call services 1003 + 5 + 1012 + 1002 + 62 separately. One HTTP GET returns everything Robinson needs for a given question.

---

## Robinson Integration Map

Robinson needs these services to extract data for minute generation:

| Robinson Function       | Tecnoreuniones Service | Purpose                              |
|-------------------------|----------------------|--------------------------------------|
| `getEventMetadata()`    | **1003**             | Assembly metadata (name, state, etc) |
| `getAttendanceList()`   | **3**                | Delegate/attendance list             |
| `getQuorumSnapshots()`  | **1007** + **62**    | Assembly status + quorum snapshots   |
| `getQuestionList()`     | **5**                | List all questions                   |
| `getVotingResults()`    | **resultsdata.php**  | Consolidated + detallado + novotan (preferred) |
| `getVotingResultsLegacy()` | **1012**          | Aggregated voting results (legacy)   |
| `getVotingDetail()`     | **1002**             | Detailed voting scrutiny (legacy)    |
| `getOfficers()`         | **8**                | Administrator info                   |
| `adminLogin()`          | **1**                | Authenticate and get token           |

### API Call Pattern

```
POST https://www.tecnoreuniones.com/vdev/tecnor2.php
Content-Type: application/x-www-form-urlencoded

service=1003&token=abc123&idAsamblea=123
```

All parameters are sent as form-encoded POST body or query string (`$_REQUEST` in PHP accepts both).
The API always returns JSON arrays (even for single records) or raw text for errors.

### Error Codes

| HTTP Code | Meaning                                  |
|-----------|------------------------------------------|
| 200       | Success                                  |
| 204       | Success, no content (service 10)         |
| 400       | Bad request / DB error                   |
| 401       | Authentication failed / not found        |
