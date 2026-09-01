# SMARTPLANT
## Production-Level Product Requirements Document
### AI + IoT + Maintenance + Operations Platform

**Document Version:** 1.0
**Date:** 1 September 2026
**Repository:** https://github.com/dushu2006/SmartPlant
**Current Primary Artifact:** `smartstock.html`
**Current Architecture:** Single HTML file with embedded CSS + JavaScript
**Target Architecture:** Production web application with backend, persistent database, IoT ingestion, AI services, observability and secure RBAC
**Document Purpose:** Senior Developer Handoff

---

# 1. EXECUTIVE SUMMARY

SmartPlant is currently a single-page web application prototype designed to provide an intelligent industrial machine monitoring and maintenance management experience.

The current prototype combines:

- Machine monitoring
- Machine details
- Power and temperature visualization
- Dashboard KPIs
- Machine scheduling
- Upcoming tasks
- Alerts
- Spare-part management
- Spare-part requests
- Technical assistance requests
- Admin approvals
- Maintenance workflows
- User profiles
- Role-based UI
- Multilingual support
- Activity logs
- CSV/XLSX/PDF exports
- Partial Firebase persistence

The current application is primarily implemented inside:

`smartstock.html`

The existing implementation should be treated as a **functional prototype and UX reference**, not as the production architecture.

The main objective now is to transform SmartPlant into a production-grade platform with:

1. Proper frontend architecture
2. Backend/API architecture
3. Persistent database
4. Real machine/IoT telemetry
5. Secure authentication and authorization
6. Reliable maintenance workflows
7. Production-grade alerts
8. AI-powered operational intelligence
9. Predictive maintenance
10. AI-assisted troubleshooting
11. AI-assisted spare-part management
12. AI-powered document/knowledge retrieval
13. Observability and auditing

The most important architectural principle is:

> The frontend must no longer be the source of truth.

The production architecture should follow:

```text
IoT Devices
     ↓
IoT Gateway / MQTT
     ↓
Telemetry Ingestion
     ↓
Database / Time-Series Storage
     ↓
Analytics + ML
     ↓
AI Orchestration
     ↓
Backend APIs
     ↓
SmartPlant Web Application
```

---

# 2. CURRENT REPOSITORY SNAPSHOT

The current repository contains:

* `README.md`
* `smartstock.html`
* `images/`

The majority of application logic is contained inside `smartstock.html`.

The application currently loads:

* Chart.js
* SheetJS
* jsPDF
* Firebase SDKs

directly in the browser.

The prototype contains substantial functionality but has very high coupling because UI, state, business logic, persistence, authentication and simulated data generation are all mixed together.

---

# 3. CURRENT SMARTPLANT FUNCTIONALITY

The following capabilities already exist conceptually in the prototype and should be preserved during the migration.

---

## 3.1 Authentication

The application currently provides a login interface.

Current roles:

* Admin
* Worker

The prototype currently contains predefined credentials.

Example current credentials:

```text
Worker
User ID: abcdefg
Password: 123456

Admin
User ID: admin
Password: 123456
```

These credentials MUST NOT exist in the production application.

Authentication must be completely redesigned.

### Production requirement

Use:

* Firebase Authentication
* Auth0
* Clerk
* Cognito
* Keycloak
* or another production-grade identity provider

The final choice is up to the senior developer.

The frontend must never contain:

* passwords
* privileged credentials
* database admin credentials
* API provider secrets

---

# 4. ROLE SYSTEM

The current application has two major roles:

```text
ADMIN
WORKER
```

Future roles may include:

```text
ADMIN
MANAGER
SUPERVISOR
TECHNICIAN
WORKER
VIEWER
```

Authorization must be implemented at the backend.

The frontend may hide UI elements, but that is NOT a security mechanism.

Example:

```text
Worker
    ↓
Frontend hides Admin page
    ↓
Backend ALSO rejects admin API request
```

Both layers are required.

---

# 5. CURRENT DASHBOARD

The dashboard currently provides several operational KPIs.

Current dashboard concepts include:

* Current Load
* Running Cost
* Monthly Estimate
* Active Machines
* Total Energy Today
* Energy chart
* Temperature chart
* Alerts
* Upcoming tasks
* Machine shortcuts
* Export functionality

The dashboard also contains admin-specific information.

---

# 6. MACHINE MONITORING

The current prototype contains eight representative machines.

```text
1. Primary Extruder
2. Milling Machine Alpha
3. Chemical Mixer
4. Pressing Machine
5. Assembly Robot R1
6. Injection Molder 3000
7. Welding Station WS2
8. Conveyor Belt Sys C5
```

Each machine currently contains information such as:

```javascript
{
    id,
    name,
    status,
    power,
    temperature,
    image,
    startTime,
    sleepTime
}
```

Example:

```javascript
{
    id: 1,
    name: "Primary Extruder",
    status: "on",
    power: 10.5,
    temperature: 55,
    image: "images/extruder.jpg",
    startTime: "08:00 AM",
    sleepTime: "05:00 PM"
}
```

---

# 7. CURRENT MACHINE ALERT RULES

The prototype currently contains threshold-based alerts.

Temperature threshold:

```text
> 60 °C
```

Power threshold:

```text
> 12 kW
```

These rules should NOT simply be deleted.

Instead, production SmartPlant should evolve from:

```text
Static Threshold
```

to:

```text
Static Threshold
+
Dynamic Baseline
+
Anomaly Detection
+
Predictive Intelligence
```

---

# 8. MACHINE DETAIL PAGE

The machine details view currently provides:

* Machine name
* Power consumption
* Starting time
* Sleeping time
* Power graph
* Temperature graph

The production version should extend this to include:

```text
Machine Overview
├── Current Status
├── Current Power
├── Current Temperature
├── Operating Hours
├── Energy Consumption
├── Active Alerts
├── Health Score
├── AI Risk Score
├── Maintenance Status
└── Last Maintenance
```

---

# 9. IMPORTANT CURRENT PROTOTYPE LIMITATION

The current machine telemetry/history is partially simulated.

The application generates machine history using random values.

Conceptually:

```javascript
Math.random()
```

is used to create realistic-looking historical values.

This MUST NOT be used as production telemetry.

Production SmartPlant must distinguish:

```text
LIVE
SIMULATED
IMPORTED
```

data sources.

Every telemetry reading should have a source.

Example:

```json
{
    "source": "device"
}
```

or:

```json
{
    "source": "simulator"
}
```

---

# 10. PRODUCTION TELEMETRY MODEL

A telemetry record should contain at minimum:

```json
{
    "id": "telemetry-id",
    "machine_id": "machine-id",
    "timestamp": "2026-09-01T12:30:00Z",
    "metric": "temperature_c",
    "value": 58.4,
    "unit": "C",
    "quality": "good",
    "source": "device",
    "received_at": "2026-09-01T12:30:02Z"
}
```

Recommended quality values:

```text
good
suspect
bad
missing
```

---

# 11. IOT ARCHITECTURE

The future system should support real machines/devices.

Recommended architecture:

```text
Sensors
   ↓
ESP32 / PLC / Gateway
   ↓
MQTT
   ↓
IoT Broker
   ↓
Telemetry Ingestion Service
   ↓
Validation + Normalization
   ↓
Time-Series Database
   ↓
Analytics / AI
```

The IoT layer must handle:

* Duplicate packets
* Offline devices
* Reconnection
* Out-of-order readings
* Missing readings
* Invalid readings
* Sensor failure
* Device authentication
* Timestamp normalization

---

# 12. DATABASE ARCHITECTURE

The frontend must not own the primary application state.

Recommended production database:

```text
PostgreSQL
```

Optionally:

```text
PostgreSQL + TimescaleDB
```

for telemetry.

---

# 13. CORE DATABASE ENTITIES

The production system should contain at least the following entities.

---

## 13.1 User

```text
User
├── id
├── email
├── display_name
├── role_id
├── status
├── locale
├── created_at
├── updated_at
└── last_login_at
```

---

## 13.2 Role

```text
Role
├── id
├── name
└── permissions
```

---

## 13.3 Plant / Site

```text
Plant
├── id
├── name
├── location
├── timezone
└── status
```

---

## 13.4 Machine

```text
Machine
├── id
├── plant_id
├── external_device_id
├── name
├── type
├── status
├── configuration
├── thresholds
├── schedule
├── metadata
├── created_at
└── updated_at
```

---

## 13.5 Telemetry

```text
TelemetryReading
├── id
├── machine_id
├── timestamp
├── metric
├── value
├── unit
├── quality
├── source
├── sequence
└── received_at
```

---

## 13.6 Alert

```text
Alert
├── id
├── machine_id
├── type
├── severity
├── status
├── message
├── evidence
├── created_at
├── acknowledged_at
└── resolved_at
```

Statuses:

```text
ACTIVE
ACKNOWLEDGED
RESOLVED
DISMISSED
```

Severity:

```text
INFO
LOW
MEDIUM
HIGH
CRITICAL
```

---

# 14. SCHEDULED TASK

```text
ScheduledTask
├── id
├── machine_id
├── task_type
├── title
├── description
├── due_at
├── recurrence
├── status
├── assigned_to
├── created_by
├── created_at
└── updated_at
```

---

# 15. MAINTENANCE EVENT

```text
MaintenanceEvent
├── id
├── machine_id
├── type
├── diagnosis
├── action
├── technician_id
├── started_at
├── completed_at
├── outcome
└── notes
```

---

# 16. MAINTENANCE REQUEST

```text
MaintenanceRequest
├── id
├── machine_id
├── requester_id
├── issue
├── priority
├── status
├── technician_id
├── created_at
└── updated_at
```

---

# 17. SPARE PART

```text
SparePart
├── id
├── sku
├── name
├── description
├── image_url
├── stock_qty
├── reorder_level
├── supplier
└── metadata
```

---

# 18. SPARE REQUEST

```text
SpareRequest
├── id
├── machine_id
├── part_id
├── quantity
├── requester_id
├── status
├── approver_id
├── eta
├── created_at
└── updated_at
```

---

# 19. MACHINE DOCUMENT

This will become important for AI.

```text
MachineDocument
├── id
├── machine_id
├── type
├── title
├── storage_url
├── extracted_text
├── version
├── uploaded_by
└── created_at
```

Examples:

```text
Machine manual
Maintenance manual
SOP
Safety document
Troubleshooting guide
Technical specification
Wiring diagram
Service document
```

---

# 20. AI INSIGHT

AI-generated insights must be stored.

```text
AIInsight
├── id
├── machine_id
├── category
├── severity
├── description
├── evidence_refs
├── confidence
├── model_version
├── created_at
└── expires_at
```

---

# 21. AUDIT EVENT

Every important operation must be auditable.

```text
AuditEvent
├── id
├── actor_id
├── action
├── entity_type
├── entity_id
├── before
├── after
├── timestamp
└── metadata
```

Examples:

```text
Admin approved spare request
Worker created assistance request
Admin changed machine configuration
Technician completed maintenance
User changed role
AI recommendation generated
AI recommendation accepted
AI recommendation rejected
```

---

# 22. FRONTEND ARCHITECTURE

The current single-file architecture must eventually be replaced.

Current:

```text
smartstock.html
    ├── HTML
    ├── CSS
    ├── JavaScript
    ├── State
    ├── Firebase
    ├── Business Logic
    └── UI
```

Target:

```text
frontend/
├── pages/
├── components/
├── layouts/
├── hooks/
├── services/
├── api/
├── stores/
├── types/
├── utils/
└── features/
    ├── dashboard/
    ├── machines/
    ├── maintenance/
    ├── inventory/
    ├── scheduling/
    ├── alerts/
    ├── users/
    └── ai/
```

Recommended frontend stack:

```text
React / Next.js
TypeScript
```

Alternative frameworks are acceptable if the senior developer has a strong reason.

---

# 23. BACKEND ARCHITECTURE

Recommended:

```text
backend/
├── auth/
├── users/
├── machines/
├── telemetry/
├── alerts/
├── maintenance/
├── inventory/
├── scheduling/
├── notifications/
├── reports/
├── ai/
├── documents/
├── audit/
└── shared/
```

The backend should own:

* Validation
* Authorization
* Business rules
* Database operations
* AI tool access
* Notifications
* Scheduling
* Audit logging

---

# 24. API DESIGN

All frontend/backend communication should happen through structured APIs.

Example:

```http
GET /api/machines
GET /api/machines/:id
GET /api/machines/:id/telemetry
GET /api/machines/:id/alerts
GET /api/machines/:id/maintenance
```

Example writes:

```http
POST /api/tasks
POST /api/maintenance-requests
POST /api/spare-requests
POST /api/assistance-requests
```

Admin:

```http
POST /api/spare-requests/:id/approve
POST /api/spare-requests/:id/reject
POST /api/maintenance-requests/:id/assign
```

AI:

```http
POST /api/ai/chat
POST /api/ai/analyze-machine
POST /api/ai/predict-maintenance
POST /api/ai/explain-alert
```

---

# 25. API PRINCIPLES

Every API should:

* Validate input
* Authenticate user
* Authorize user
* Return structured errors
* Use server timestamps
* Support pagination
* Support filtering
* Support retries
* Be idempotent where appropriate
* Avoid exposing raw database records

Example error:

```json
{
    "error": {
        "code": "UNAUTHORIZED_ACTION",
        "message": "You do not have permission to approve this request."
    }
}
```

---

# 26. PRODUCTION MIGRATION STRATEGY

Do NOT continue endlessly expanding `smartstock.html`.

Instead:

```text
Existing Prototype
        ↓
Document Existing Behavior
        ↓
Create Production Backend
        ↓
Create Database
        ↓
Create Authentication
        ↓
Create API Layer
        ↓
Create New Frontend
        ↓
Migrate Features
        ↓
Add AI
        ↓
Production Testing
```

The old application should remain available as a reference during migration.

---

# 27. MIGRATION ORDER

Recommended order:

### Phase 1

Production foundation:

* Project structure
* Backend
* Database
* Authentication
* RBAC
* API
* Environment configuration

### Phase 2

Core machine platform:

* Machines
* Telemetry
* Dashboard
* Machine details
* Alerts

### Phase 3

Operations:

* Scheduling
* Maintenance
* Assistance requests
* Spare parts
* Admin approval

### Phase 4

AI:

* AI Copilot
* Machine analysis
* Alert explanation
* RAG

### Phase 5

Advanced AI:

* Predictive maintenance
* Forecasting
* Ticket triage
* Spare recommendations
* Computer vision

---

# 28. AI PRODUCT VISION

AI should not be added merely as:

```text
"Chat with an AI"
```

Instead:

```text
SmartPlant Intelligence Layer
```

should sit above the operational platform.

The AI should understand:

```text
Machines
Telemetry
Alerts
Maintenance
Schedules
Spare Parts
Documents
Users
Historical Events
```

This allows the AI to answer questions using actual SmartPlant data.

---

# 29. AI CAPABILITIES

The AI roadmap contains:

```text
1. AI Copilot
2. Anomaly Detection
3. Alert Explanation
4. Predictive Maintenance
5. Maintenance Recommendation
6. Spare-Part Intelligence
7. Ticket Triage
8. Document RAG
9. Forecasting
10. Computer Vision
```

---

# 30. AI COPILOT

The AI Copilot should be the first AI feature.

Users should be able to ask:

```text
"Is the Primary Extruder okay?"

"Why is the temperature high?"

"What machines need attention?"

"What happened to the mixer yesterday?"

"When was the last maintenance?"

"Do we have the required spare part?"

"Schedule a maintenance inspection tomorrow."

"Create a technician request for the extruder."
```

The AI must use tools rather than guessing.

---

# 31. AI TOOL SYSTEM

The AI should have access to controlled backend tools.

Example:

```text
get_machine_status()
get_machine_history()
get_active_alerts()
get_maintenance_history()
get_open_requests()
get_spare_inventory()
get_machine_documents()
create_task()
create_assistance_request()
```

The LLM should NOT directly access the database.

Instead:

```text
LLM
 ↓
AI Tool
 ↓
Backend API
 ↓
Database
```

---

# 32. AI MACHINE STATUS TOOL

Example:

```text
get_machine_status(machine_id)
```

Returns:

```json
{
    "machine": "Primary Extruder",
    "status": "RUNNING",
    "temperature": 58.4,
    "temperature_unit": "C",
    "power": 10.7,
    "power_unit": "kW",
    "last_updated": "2026-09-01T12:30:00Z",
    "data_freshness_seconds": 4
}
```

The AI must use this result.

It must NOT invent values.

---

# 33. AI GROUNDED ANSWERS

Example question:

```text
Why is the Primary Extruder showing an alert?
```

The AI should retrieve:

```text
Current telemetry
+
Historical telemetry
+
Active alerts
+
Maintenance history
+
Machine documentation
```

Then produce:

```text
The Primary Extruder is currently showing elevated temperature.

Current temperature: 63.2 °C
Normal recent range: 48–57 °C
Alert threshold: 60 °C

The temperature has increased continuously for approximately 18 minutes.

Possible causes include:
1. Cooling-system degradation
2. Increased operating load
3. Temperature sensor issue

Recommended next step:
Inspect the cooling system and verify the temperature sensor.

Confidence: Medium
```

The system should identify the evidence behind the answer.

---

# 34. AI SAFETY PRINCIPLE

The AI must never pretend certainty when evidence is insufficient.

Bad:

```text
The motor is definitely damaged.
```

Better:

```text
The telemetry pattern is consistent with abnormal motor behavior, but the available data is insufficient to confirm a mechanical failure.
```

---

# 35. AI NUMERICAL ACCURACY

All numerical information must come from:

* Backend calculation
* Database result
* ML model result
* Explicit deterministic formula

The LLM must not calculate critical operational values from memory.

Examples:

```text
Power
Temperature
Energy
Cost
Inventory
Maintenance dates
Operating hours
```

must be retrieved or calculated by backend services.

---

# 36. ANOMALY DETECTION

The current system uses static thresholds.

Production SmartPlant should introduce:

```text
Static Threshold
        +
Historical Baseline
        +
Statistical Anomaly Detection
        +
Machine-Specific Patterns
```

Potential features:

```text
Mean
Median
Variance
Rolling average
Rolling standard deviation
Slope
Rate of change
Maximum
Minimum
Threshold duration
Operating hours
Load normalization
Temperature/power correlation
```

---

# 37. ANOMALY EXAMPLE

Suppose:

```text
Normal temperature:
45–55 °C

Current:
57 °C
```

Static threshold might say:

```text
No alert
```

But AI could detect:

```text
Temperature has increased 10 °C
over the last 15 minutes.
```

and determine:

```text
Unusual trend detected.
```

Therefore SmartPlant becomes proactive rather than reactive.

---

# 38. PREDICTIVE MAINTENANCE

Predictive maintenance should estimate the likelihood of maintenance/failure risk.

Potential inputs:

```text
Temperature
Power
Vibration
Operating hours
Start/stop cycles
Load
Historical maintenance
Previous failures
Alert frequency
Machine age
Maintenance intervals
```

Output:

```json
{
    "machine_id": "machine-001",
    "risk_level": "HIGH",
    "risk_score": 0.81,
    "prediction_horizon": "7 days",
    "confidence": 0.76,
    "top_signals": [
        "Increasing temperature trend",
        "Higher-than-normal power variance",
        "Repeated temperature alerts"
    ]
}
```

---

# 39. IMPORTANT PREDICTIVE MAINTENANCE RULE

Do NOT claim accurate failure probability before enough real-world data exists.

Initially use:

```text
Health Score
+
Anomaly Score
+
Risk Indicators
```

rather than pretending to have a scientifically validated failure probability.

Once sufficient labeled maintenance/failure data exists, train and evaluate a predictive model.

---

# 40. MODEL DEVELOPMENT STRATEGY

Do not immediately build a deep neural network.

Start with:

```text
Baseline statistical models
        ↓
Classical ML
        ↓
Advanced ML
        ↓
Deep learning if justified
```

Potential initial models:

```text
Isolation Forest
Random Forest
XGBoost
LightGBM
Logistic Regression
Gradient Boosting
Time-series forecasting models
```

The final choice should depend on available data.

---

# 41. MAINTENANCE RECOMMENDATION ENGINE

The AI should combine:

```text
Machine telemetry
+
Detected anomaly
+
Maintenance history
+
Machine documentation
+
Available spare parts
```

Example:

```text
Issue:
Extruder temperature rising abnormally.

AI recommendation:

1. Inspect cooling system.
2. Check temperature sensor.
3. Inspect heating element.
4. Compare current operating load with historical baseline.

Potential spare parts:
- Temperature Sensor
- Heating Element

Inventory:
Temperature Sensor → 4 available
Heating Element → 2 available
```

---

# 42. SPARE-PART INTELLIGENCE

The current spare-part catalog is static JavaScript.

Production system should store it in the database.

AI can then answer:

```text
"What spare part do I need?"

"Do we have it?"

"How many are available?"

"Which part is compatible with this machine?"

"What should we reorder?"
```

AI must never invent compatibility.

Compatibility must come from:

```text
Machine-Part relationship
+
Manufacturer data
+
Approved catalog
+
Technical documents
```

---

# 43. AI TICKET TRIAGE

Workers currently submit free-text technical issues.

Example:

```text
"The extruder is making a strange sound and temperature is going up."
```

AI can structure this into:

```json
{
    "machine": "Primary Extruder",
    "category": "Thermal / Mechanical",
    "priority": "HIGH",
    "symptoms": [
        "Abnormal sound",
        "Increasing temperature"
    ],
    "possible_subsystems": [
        "Cooling system",
        "Motor",
        "Bearing"
    ]
}
```

The final priority should remain subject to deterministic business rules and human oversight.

---

# 44. DOCUMENT RAG

SmartPlant should eventually allow machines to have associated documents.

Examples:

```text
Machine Manual
Maintenance Manual
SOP
Troubleshooting Guide
Safety Procedure
Parts Manual
```

The AI should retrieve relevant sections.

Architecture:

```text
Document
   ↓
Text Extraction
   ↓
Chunking
   ↓
Embeddings
   ↓
Vector Database
   ↓
Retriever
   ↓
AI Copilot
```

---

# 45. DOCUMENT QUESTION EXAMPLE

User:

```text
How should I troubleshoot high temperature on the Primary Extruder?
```

AI:

```text
According to the Primary Extruder maintenance manual:

1. Check cooling flow.
2. Inspect the temperature sensor.
3. Verify heating-element behavior.
4. Confirm operating load.

The current machine telemetry also shows...
```

The AI should provide document/source references.

---

# 46. AI + REAL-TIME DATA

The AI must understand data freshness.

Example:

```text
Current temperature:
61.4 °C

Last reading:
42 seconds ago
```

The AI should say:

```text
The latest available reading is 42 seconds old.
```

If the machine has been offline:

```text
I cannot confirm the machine's current temperature because the latest reading is 17 minutes old.
```

---

# 47. AI ACTIONS

The AI may eventually perform controlled actions.

Examples:

```text
Create maintenance task
Create assistance request
Create spare request
Schedule inspection
Acknowledge alert
```

But actions must follow:

```text
User
 ↓
AI
 ↓
Action Preview
 ↓
User Confirmation
 ↓
Backend Authorization
 ↓
Action
 ↓
Audit Log
```

For safety-critical operations:

```text
LLM
   ↓
NEVER DIRECT MACHINE CONTROL
```

unless an explicit, deterministic and separately authorized control system exists.

---

# 48. AI ACTION CONFIRMATION

Example:

```text
AI:

I can schedule a maintenance inspection for
Primary Extruder tomorrow at 10:00 AM.

Machine:
Primary Extruder

Task:
Maintenance Inspection

Time:
10:00 AM

Confirm?
```

Only after confirmation:

```text
POST /api/tasks
```

---

# 49. AI INSIGHT STORAGE

Every generated operational insight should contain:

```text
Machine
Category
Severity
Evidence
Confidence
Model version
Created timestamp
Expiration
```

This enables:

```text
Historical AI analysis
Model evaluation
Auditability
User feedback
```

---

# 50. AI FEEDBACK LOOP

Users should be able to mark insights:

```text
Useful
Not useful
Correct
Incorrect
```

For maintenance recommendations:

```text
Accepted
Rejected
Partially useful
```

This feedback can eventually be used for model improvement.

---

# 51. NOTIFICATION SYSTEM

Production notifications should be event driven.

Possible channels:

```text
In-app
Browser Push
Email
SMS
```

depending on scope.

Notification types:

```text
Critical alert
High temperature
High power
Machine offline
Maintenance due
Spare request approved
Spare request rejected
Technician assigned
AI high-risk insight
```

Notifications must be deduplicated.

---

# 52. ALERT ENGINE

Instead of directly checking:

```javascript
if (temperature > 60)
```

the backend should have an alert engine.

Conceptually:

```text
Telemetry
   ↓
Rule Engine
   ↓
Baseline Analysis
   ↓
Anomaly Detection
   ↓
Alert Decision
   ↓
Alert Database
   ↓
Notification Service
```

---

# 53. ALERT LIFECYCLE

```text
DETECTED
   ↓
ACTIVE
   ↓
ACKNOWLEDGED
   ↓
RESOLVED
```

or:

```text
ACTIVE
   ↓
DISMISSED
```

Every transition should be audited.

---

# 54. SCHEDULING

Current scheduling allows:

```text
Machine
Task name
Time
```

Production scheduling should support:

```text
Machine
Task
Description
Date
Time
Timezone
Recurrence
Priority
Assigned person
Status
Notes
```

Example recurrence:

```text
Every day
Every week
Every month
Custom interval
```

---

# 55. MAINTENANCE WORKFLOW

Recommended workflow:

```text
Issue detected
     ↓
Alert / Worker Request
     ↓
Triage
     ↓
Priority
     ↓
Technician Assignment
     ↓
Spare Part Requirement
     ↓
Maintenance
     ↓
Verification
     ↓
Resolution
     ↓
Maintenance History
```

---

# 56. SPARE REQUEST WORKFLOW

```text
Worker
  ↓
Create Request
  ↓
Pending
  ↓
Admin Review
  ↓
Approved / Rejected
  ↓
Inventory Update
  ↓
ETA
  ↓
Delivered
  ↓
Used
```

Inventory changes must be transactional.

---

# 57. INVENTORY REQUIREMENTS

Inventory should support:

```text
Stock quantity
Reserved quantity
Available quantity
Reorder level
Supplier
Lead time
Compatible machines
Part status
```

Example:

```text
Available = Stock - Reserved
```

The calculation should happen server-side.

---

# 58. REPORTING

Current reports include:

```text
CSV
XLSX
PDF
```

Production reporting should support:

```text
Machine health report
Energy report
Maintenance report
Alert report
Spare inventory report
Request report
AI insights report
```

Large reports should be generated asynchronously.

---

# 59. SECURITY REQUIREMENTS

Production SmartPlant MUST:

* Remove hard-coded credentials.
* Remove secrets from frontend.
* Enforce backend authorization.
* Secure database access.
* Validate uploads.
* Use signed file URLs.
* Rate-limit authentication.
* Rate-limit AI requests.
* Audit privileged actions.
* Secure API endpoints.
* Configure CORS properly.
* Use secure headers.
* Protect sessions/tokens.
* Validate all user input.

---

# 60. OBSERVABILITY

The production system must include:

```text
Structured logging
Metrics
Tracing
Error tracking
Health checks
Performance monitoring
AI monitoring
IoT monitoring
```

Monitor:

```text
API latency
Database latency
Telemetry ingestion latency
Dropped telemetry
Offline machines
Alert generation
Notification failures
AI latency
AI failures
AI tool failures
Model drift
```

---

# 61. DEMO MODE

The current prototype uses simulated data.

Production SmartPlant should support:

```text
DEMO
PRODUCTION
```

Demo mode may generate synthetic data.

Production mode must clearly identify:

```text
LIVE DEVICE DATA
```

Every telemetry record should have:

```text
source = device
```

or:

```text
source = simulator
```

The UI should visibly indicate the environment.

---

# 62. CURRENT SYNTHETIC DATA MUST NOT BE MIGRATED AS REAL HISTORY

The existing randomly generated history should not be presented as real operational history.

It may be retained as:

```text
Demo fixture
```

but never as:

```text
Production historical telemetry
```

---

# 63. CURRENT PROTOTYPE → PRODUCTION MAPPING

| Current Prototype         | Production Replacement           |
| ------------------------- | -------------------------------- |
| `machinesData`            | Machine database                 |
| `scheduledTasks`          | ScheduledTask table/API          |
| `activityLogs`            | AuditEvent                       |
| `machineHistory`          | Telemetry/time-series DB         |
| `spareRequests`           | SpareRequest                     |
| `assistanceRequests`      | MaintenanceRequest               |
| `sparePartsCatalog`       | SparePart + MachinePart          |
| Hard-coded users          | Identity provider                |
| Client role variable      | Backend RBAC                     |
| `Math.random()` telemetry | IoT telemetry                    |
| `setTimeout()` simulation | Background jobs/workflows        |
| Client alerts             | Backend alert engine             |
| Client exports            | Reporting service                |
| Static images             | Object storage                   |
| Browser Firebase calls    | Backend/data-access layer        |
| AI future feature         | Dedicated AI orchestration layer |

---

# 64. TESTING STRATEGY

Production SmartPlant should include:

## Unit Tests

Test:

* Business rules
* Alert rules
* Calculations
* Permission checks
* Inventory calculations
* AI tool validation

## Integration Tests

Test:

* API + database
* Authentication
* Telemetry ingestion
* Alerts
* Maintenance workflow
* Inventory workflow
* AI tools

## End-to-End Tests

Test:

```text
Login
 ↓
Dashboard
 ↓
Machine
 ↓
Alert
 ↓
Maintenance request
 ↓
Admin approval
 ↓
Technician workflow
 ↓
Resolution
```

---

# 65. AI TESTING

AI must have its own evaluation suite.

Measure:

```text
Grounding accuracy
Citation accuracy
Tool selection
Tool execution
Unsupported claims
Hallucination rate
Response latency
Action safety
```

Critical requirement:

```text
Unauthorized AI action rate = 0
```

---

# 66. AI EVALUATION DATASET

Create a controlled evaluation dataset containing:

```text
Normal machine cases
High temperature cases
High power cases
Sensor failure cases
Offline machine cases
Maintenance cases
Inventory cases
Document questions
Ambiguous questions
Unsupported questions
```

Example:

```text
Question:
What is the current temperature?

Expected:
Use telemetry tool.

Question:
Why is the machine overheating?

Expected:
Retrieve telemetry + alerts + history.

Question:
Order 500 units of an unknown part.

Expected:
Do not fabricate part information.
```

---

# 67. AI RESPONSE POLICY

The AI should follow these principles:

```text
1. Never fabricate telemetry.
2. Never fabricate inventory.
3. Never fabricate maintenance history.
4. Never fabricate document content.
5. Never fabricate costs.
6. Never claim unsupported certainty.
7. Explain evidence.
8. Show freshness when relevant.
9. Respect user permissions.
10. Ask for confirmation before operational actions.
```

---

# 68. PRODUCTION SLOs

Before launch, define measurable targets for:

```text
API availability
Dashboard latency
Telemetry ingestion latency
AI response latency
Notification delivery
Database recovery
Backup recovery
```

Example targets can be selected by the engineering team based on deployment scale.

---

# 69. DATA RETENTION

Define policies for:

```text
Raw telemetry
Aggregated telemetry
Alerts
Audit logs
Maintenance history
AI conversations
AI insights
Uploaded documents
Reports
```

Do not delete operational/audit information merely to simplify storage.

---

# 70. PRIVACY

The system must minimize unnecessary personal information.

User data should be limited to what is operationally required.

AI conversation data should have an explicit retention policy.

Sensitive data should never be unnecessarily included in AI prompts.

---

# 71. AI COST CONTROL

The AI layer should monitor:

```text
Requests
Tokens
Model usage
Latency
Cost
Tool calls
Failures
```

Use:

```text
Smaller model → simple tasks
Larger model → complex reasoning
Deterministic backend → calculations
ML model → predictive tasks
LLM → language/orchestration
```

Do not use an LLM for work that a deterministic function can perform reliably.

---

# 72. RECOMMENDED AI ARCHITECTURE

```text
                         SMARTPLANT
                             │
              ┌──────────────┴──────────────┐
              │                             │
          Operational Data              Documents
              │                             │
        ┌─────┴─────┐                  ┌────┴────┐
        │           │                  │         │
    PostgreSQL  Time Series          Storage   Vector DB
        │           │                  │         │
        └─────┬─────┘                  └────┬────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                     AI Orchestrator
                             │
              ┌──────────────┼──────────────┐
              │              │              │
          ML Models       AI Tools        RAG
              │              │              │
              └──────────────┼──────────────┘
                             │
                           LLM
                             │
                       SmartPlant AI
                             │
                    Web / Mobile UI
```

---

# 73. AI RESPONSIBILITY SEPARATION

Use the following architecture:

```text
Deterministic Backend
    ↓
Metrics
Calculations
Rules
Permissions
Transactions

ML Layer
    ↓
Anomaly Detection
Prediction
Forecasting
Classification

LLM Layer
    ↓
Understanding
Explanation
Tool selection
Conversation
Synthesis
```

Do not merge all three responsibilities into one LLM.

---

# 74. DEVELOPMENT ROADMAP

## PHASE 0 — FOUNDATION

Build:

```text
Repository structure
Frontend
Backend
Database
Authentication
RBAC
API
Environment configuration
Logging
Testing
CI/CD
```

Exit criteria:

```text
Users can securely authenticate.
Backend controls permissions.
Database is authoritative.
```

---

# 75. PHASE 1 — PRODUCTION CORE

Build:

```text
Machines
Telemetry
Dashboard
Machine details
Alerts
Scheduling
Maintenance
Inventory
Requests
Admin workflows
```

Exit criteria:

```text
No production feature depends on browser-only state.
```

---

# 76. PHASE 2 — AI COPILOT

Build:

```text
AI chat UI
AI backend
Tool calling
Machine context
Alert context
Maintenance context
Inventory context
Permission-aware actions
Evidence display
```

Exit criteria:

```text
AI can answer operational questions using actual SmartPlant data.
```

---

# 77. PHASE 3 — ANOMALY INTELLIGENCE

Build:

```text
Machine baselines
Anomaly detection
Trend detection
Dynamic alerts
AI explanations
```

Exit criteria:

```text
AI can identify unusual behavior beyond fixed thresholds.
```

---

# 78. PHASE 4 — PREDICTIVE MAINTENANCE

Build:

```text
Feature pipeline
ML model
Model versioning
Risk scores
Evaluation dataset
Prediction monitoring
Maintenance feedback
```

Exit criteria:

```text
Predictions are measurable against real maintenance outcomes.
```

---

# 79. PHASE 5 — AI MAINTENANCE INTELLIGENCE

Build:

```text
Ticket triage
Spare recommendation
Maintenance recommendations
Document RAG
Technician assistant
```

---

# 80. PHASE 6 — ADVANCED AI

Potential features:

```text
Computer vision
Machine image inspection
Advanced forecasting
Fleet benchmarking
Failure pattern mining
Automated maintenance planning
```

These should only be implemented when sufficient data and business justification exist.

---

# 81. NON-GOALS

The first production version should NOT attempt:

```text
Fully autonomous machine control
LLM-only safety decisions
Training a foundation model
Fake predictive failure probabilities
Replacing deterministic calculations with LLMs
Building every AI feature simultaneously
```

---

# 82. PRODUCTION ACCEPTANCE CRITERIA

## Authentication

* Users can securely authenticate.
* Credentials are not exposed.
* Sessions are secure.
* Password recovery works.

## Authorization

* Workers cannot access admin APIs.
* Admin permissions are backend-enforced.
* Privileged operations are audited.

## Data

* Machine data survives refresh.
* Multiple users see consistent data.
* Database is authoritative.
* Telemetry has timestamps and quality.

## Dashboard

* Dashboard uses backend data.
* No production telemetry is generated with `Math.random()`.
* Data freshness is visible.

## Alerts

* Alerts persist.
* Alert states are tracked.
* Notifications are deduplicated.
* Alerts are auditable.

## Maintenance

* Requests persist.
* Assignments persist.
* State transitions are reliable.
* Maintenance history is retained.

## Inventory

* Stock is transactional.
* Reserved stock is tracked.
* Approval changes are audited.

## AI

* AI answers are grounded.
* AI cannot invent machine values.
* AI cannot invent inventory.
* AI respects permissions.
* AI actions require appropriate confirmation.
* AI insights expose evidence/confidence.
* AI model versions are recorded.

---

# 83. FINAL ENGINEERING PRINCIPLES

SmartPlant development should follow these principles:

### 1. Database is the source of truth.

Not JavaScript variables.

### 2. Backend owns business logic.

Not browser code.

### 3. Authentication and authorization are separate concepts.

Authentication identifies the user.

Authorization determines what they can do.

### 4. Telemetry must be trustworthy.

Every reading should have:

```text
timestamp
machine
metric
value
unit
quality
source
```

### 5. AI does not replace the backend.

AI operates through controlled tools.

### 6. LLMs should explain and orchestrate.

They should not invent operational data.

### 7. Machine learning should produce measurable predictions.

Do not claim predictive capability without evaluation.

### 8. Safety-critical operations must remain deterministic.

AI may recommend.

Authorized systems execute.

### 9. Demo data must be clearly separated from production data.

Never present simulated data as real telemetry.

### 10. Everything important should be auditable.

Every important action should leave an audit record.

---

# 84. SENIOR DEVELOPER HANDOFF

The current `smartstock.html` application should be considered the **functional prototype**.

It demonstrates the intended product experience and contains significant UI/workflow logic.

However, it should NOT become the production codebase by continuously adding more JavaScript to the file.

The recommended strategy is:

```text
KEEP
    Existing prototype
        ↓
    UX reference
        ↓
    Functional reference

BUILD
    Production frontend
        +
    Backend
        +
    Database
        +
    IoT layer
        +
    AI layer

THEN
    Gradually migrate existing functionality.
```

The first priority is not AI.

The first priority is creating a trustworthy production data and API foundation.

AI becomes significantly more valuable once SmartPlant has:

```text
Reliable machine data
+
Historical data
+
Maintenance history
+
Inventory
+
Documents
+
Permissions
```

At that point, SmartPlant can evolve from a machine-monitoring dashboard into an actual **AI-powered industrial operations platform**.

---

# 85. FINAL TARGET ARCHITECTURE

```text
                         ┌───────────────────────┐
                         │     SMARTPLANT UI     │
                         │ Web / Mobile / Admin  │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │      API GATEWAY      │
                         └───────────┬───────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
 ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
 │ Machine Service │       │ Maintenance     │       │ Inventory       │
 │                 │       │ Service         │       │ Service         │
 └────────┬────────┘       └────────┬────────┘       └────────┬────────┘
          │                         │                         │
          └─────────────────────────┼─────────────────────────┘
                                    │
                                    ▼
                         ┌───────────────────────┐
                         │      DATABASE         │
                         │ PostgreSQL / TSDB     │
                         └───────────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
       ┌─────────────┐       ┌──────────────┐       ┌──────────────┐
       │ IoT Layer   │       │ Analytics    │       │ Documents    │
       │ MQTT        │       │ + ML         │       │ + RAG        │
       └──────┬──────┘       └──────┬───────┘       └──────┬───────┘
              │                     │                      │
              └─────────────────────┼──────────────────────┘
                                    │
                                    ▼
                         ┌───────────────────────┐
                         │    AI ORCHESTRATOR   │
                         │                       │
                         │ Tools + RAG + Policy  │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │         LLM           │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │   SMARTPLANT AI       │
                         │ Copilot / Insights    │
                         └───────────────────────┘
```

---

# 86. DEFINITION OF DONE

SmartPlant should be considered production-ready only when:

```text
[ ] Secure authentication
[ ] Backend-enforced RBAC
[ ] Production database
[ ] Production API
[ ] Real telemetry ingestion
[ ] Reliable dashboard
[ ] Persistent machine state
[ ] Persistent alerts
[ ] Persistent maintenance workflow
[ ] Persistent inventory
[ ] Persistent scheduling
[ ] Audit logging
[ ] Notification system
[ ] Observability
[ ] Automated testing
[ ] CI/CD
[ ] Secure secret management
[ ] AI Copilot
[ ] AI tool layer
[ ] AI grounding
[ ] AI evaluation
[ ] Anomaly detection
[ ] Predictive maintenance baseline
[ ] AI maintenance recommendations
[ ] Document RAG
[ ] Production security review
[ ] Production deployment
```

---

# END OF SMARTPLANT PRODUCTION PRD
