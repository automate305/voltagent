# HVAC Live Demo — Arctic Air HVAC

A complete, production-inspired example demonstrating VoltAgent's workflow primitives using a fictional HVAC service company.

## Patterns Demonstrated

| VoltAgent Feature | Where It's Used |
|---|---|
| `andAgent` with tool use | Service Request: triage step calls `get_customer_history` |
| `getStepData` for context recovery | Service Request: `dispatch` + `estimate` recover fields lost after `andAgent` |
| `workflowState` persistence | Service Request: `ticketId`, urgency persist across all 7 steps |
| `andBranch` | Service Request: routes to emergency / scheduled / preventive |
| `andTap` for side effects | Logging steps in all workflows |
| `suspend` / `resume` | Quote Approval: pauses for manager sign-off on quotes > $1,000 |
| `andForEach` with concurrency | Maintenance Batch: schedules units 2 at a time |
| Wrapped agent call in `andThen` | Maintenance Batch: `reminderAgent.generateText()` per unit |
| `andMap` aggregation | Maintenance Batch: builds revenue summary from array |
| Multi-output AI generation | Emergency: one agent produces both customer SMS and tech brief |
| Time-based business logic | Emergency: after-hours surge pricing (1.5×) |

## Workflows

### 1. `hvac-service-request` — Service Request Triage

The primary demo. Takes a customer request and produces a complete job ticket.

**Steps:** init → AI triage (w/ customer history tool) → dispatch technician → AI diagnosis → estimate cost → branch by urgency → finalize ticket

**Returning customer (warranty discount):**
```json
{
  "customerName": "John Smith",
  "phone": "555-1234",
  "address": "123 Main St, Miami FL 33101",
  "issueDescription": "AC stopped blowing cold air and is making a clicking noise",
  "equipmentType": "central-ac",
  "equipmentAge": 8
}
```

**Emergency scenario:**
```json
{
  "customerName": "Maria Lopez",
  "phone": "555-0000",
  "address": "789 Oak Ave, Miami FL",
  "issueDescription": "Furnace won't turn on and there's a gas smell",
  "equipmentType": "furnace",
  "equipmentAge": 12
}
```

---

### 2. `hvac-quote-approval` — Quote Approval (Suspend/Resume)

Quotes **under $1,000** auto-approve. Quotes **over $1,000** suspend the workflow and wait for a manager to resume it.

**Resume payload:**
```json
{ "approved": true, "managerId": "MGR-001", "comments": "Approved — customer is VIP" }
```

**High-value quote (will suspend):**
```json
{
  "ticketId": "TKT-ABC123",
  "customerName": "John Smith",
  "jobType": "replacement",
  "equipmentType": "central-ac",
  "issueDescription": "Compressor failure on 8-year-old unit",
  "partsNeeded": ["compressor", "evaporator_coil", "refrigerant_r410a"],
  "isReturningCustomer": true,
  "warrantyActive": false
}
```

---

### 3. `hvac-maintenance-batch` — Seasonal Maintenance Batch

Takes an array of units, schedules tune-ups in parallel (2 concurrent), and generates a personalized AI SMS reminder for each customer.

```json
[
  { "unitId": "U001", "customerName": "Alice Johnson", "address": "100 Pine St", "equipmentType": "central-ac", "lastServiceDate": "2024-03-15" },
  { "unitId": "U002", "customerName": "Bob Chen", "address": "200 Elm Ave", "equipmentType": "heat-pump" },
  { "unitId": "U003", "customerName": "Carol Davis", "address": "300 Oak Blvd", "equipmentType": "furnace", "lastServiceDate": "2023-10-01" }
]
```

---

### 4. `hvac-emergency-afterhours` — Emergency After-Hours Dispatch

Handles urgent calls 24/7. Includes safety risk assessment, on-call tech dispatch, and automated communications. Calls after 8pm or on weekends get **1.5× surge pricing**.

**Gas leak:**
```json
{
  "customerName": "David Park",
  "phone": "555-7777",
  "address": "456 Maple Dr, Miami FL",
  "issueDescription": "Strong gas smell near furnace, pilot light is out",
  "equipmentType": "furnace"
}
```

**No heat:**
```json
{
  "customerName": "Susan Miller",
  "phone": "555-8888",
  "address": "789 Cedar Ln, Miami FL",
  "issueDescription": "Heat pump not heating at all, outdoor unit not running",
  "equipmentType": "heat-pump"
}
```

---

## Setup

```bash
cd examples/with-hvac-demo
cp .env.example .env        # add your ANTHROPIC_API_KEY
pnpm install
pnpm dev
```

Open the VoltAgent console URL shown in the terminal to run workflows interactively.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `VOLTAGENT_PUBLIC_KEY` | Optional | VoltAgent cloud tracing |
| `VOLTAGENT_SECRET_KEY` | Optional | VoltAgent cloud tracing |

## Model Configuration

All agents use `anthropic/claude-haiku-4-5-20251001` by default. Change the `MODEL` constant in `src/index.ts` to upgrade:

```typescript
const MODEL = "anthropic/claude-haiku-4-5-20251001"; // fast & cheap
// const MODEL = "anthropic/claude-sonnet-4-6";       // balanced
// const MODEL = "anthropic/claude-opus-4-7";          // most capable
```
