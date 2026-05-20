import {
  Agent,
  VoltAgent,
  andAgent,
  andBranch,
  andForEach,
  andMap,
  andTap,
  andThen,
  createTool,
  createWorkflow,
} from "@voltagent/core";
import { createPinoLogger } from "@voltagent/logger";
import { honoServer } from "@voltagent/server-hono";
import { z } from "zod";

// ============================================================
// Mock Data (simulates a real HVAC company database)
// ============================================================

const TECHNICIANS = [
  { id: "T001", name: "Maria Garcia", skills: ["residential", "commercial", "refrigerant"], available: true },
  { id: "T002", name: "James Wilson", skills: ["residential", "ductwork", "electrical"], available: true },
  { id: "T003", name: "Sarah Chen", skills: ["commercial", "chillers", "refrigerant"], available: false },
  { id: "T004", name: "Mike Torres", skills: ["residential", "heat-pump", "tune-up"], available: true },
];

const ON_CALL_ROSTER = [
  { id: "OC001", name: "Alex Rivera", phone: "555-0100", available: true },
  { id: "OC002", name: "Pat Kim", phone: "555-0101", available: true },
];

const PARTS_CATALOG: Record<string, number> = {
  compressor: 850,
  condenser_fan_motor: 280,
  capacitor: 45,
  contactor: 55,
  refrigerant_r410a: 120,
  filter_replacement: 35,
  thermostat: 150,
  blower_motor: 320,
  evaporator_coil: 720,
  heat_exchanger: 940,
  igniter: 95,
  control_board: 450,
};

const CUSTOMER_DB: Record<
  string,
  { customerId: string; lastService: string; warrantyActive: boolean; visits: number; notes: string }
> = {
  "5551234": { customerId: "CUST-8821", lastService: "2024-11-15", warrantyActive: true, visits: 4, notes: "Prefers morning appointments" },
  "5559876": { customerId: "CUST-4402", lastService: "2023-06-20", warrantyActive: false, visits: 2, notes: "" },
};

// ============================================================
// Tools
// ============================================================

/** Attached to triageAgent — lets the AI look up customer history before classifying. */
const getCustomerHistoryTool = createTool({
  name: "get_customer_history",
  description: "Look up a customer's service history and warranty status by phone number",
  parameters: z.object({
    phone: z.string().describe("Customer phone number"),
  }),
  execute: async ({ phone }) => {
    const digits = phone.replace(/\D/g, "").slice(-7);
    const record = CUSTOMER_DB[digits];
    if (record) return { found: true, ...record, isReturningCustomer: true };
    return {
      found: false,
      customerId: `CUST-NEW-${Date.now().toString(36).toUpperCase()}`,
      isReturningCustomer: false,
      warrantyActive: false,
      visits: 0,
      notes: "",
    };
  },
});

// ============================================================
// Utility functions (called directly in workflow steps)
// ============================================================

async function checkTechnicianAvailability(requiredSkills: string[], isEmergency: boolean) {
  const matches = TECHNICIANS.filter(
    (t) => t.available && (requiredSkills.length === 0 || requiredSkills.some((s) => t.skills.includes(s))),
  );
  const assigned = matches[0] ?? null;
  return {
    technicianAvailable: matches.length > 0,
    assignedTechnician: assigned ? { id: assigned.id, name: assigned.name } : null,
    eta: isEmergency ? "60–90 minutes" : "Today 2pm–5pm",
  };
}

async function getPartsEstimate(partNames: string[]) {
  const breakdown: Record<string, number> = {};
  let subtotal = 0;
  for (const part of partNames) {
    const key = part.toLowerCase().replace(/\s+/g, "_");
    const price = PARTS_CATALOG[key] ?? 120;
    breakdown[part] = price;
    subtotal += price;
  }
  const laborHours = Math.max(1, Math.ceil(partNames.length * 0.75));
  return { breakdown, subtotal, laborHours, laborRate: 95 };
}

// ============================================================
// Agents
// Change MODEL to "anthropic/claude-sonnet-4-6" or
// "anthropic/claude-opus-4-7" for more capable responses.
// ============================================================

const MODEL = "anthropic/claude-haiku-4-5-20251001";

const triageAgent = new Agent({
  name: "HVACTriageAgent",
  model: MODEL,
  instructions: `You are an experienced HVAC service coordinator at Arctic Air HVAC.
Assess incoming service requests by:
1. Calling get_customer_history with the customer's phone number first
2. Classifying urgency: "emergency" (no AC/heat, safety risk), "scheduled" (degraded performance), "preventive" (routine maintenance)
3. Identifying jobType: "repair", "replacement", "tune-up", "inspection", or "installation"
4. Listing requiredSkills from: ["residential", "commercial", "refrigerant", "electrical", "ductwork", "heat-pump", "chillers", "tune-up"]
Always call the history tool before responding. Be concise and accurate.`,
  tools: [getCustomerHistoryTool],
});

const diagnosisAgent = new Agent({
  name: "HVACDiagnosisAgent",
  model: MODEL,
  instructions: `You are a senior HVAC technician with 15+ years of field experience.
Diagnose HVAC issues based on reported symptoms. List only parts from this catalog
that are genuinely indicated by the symptoms:
compressor, condenser_fan_motor, capacitor, contactor, refrigerant_r410a,
filter_replacement, thermostat, blower_motor, evaporator_coil, heat_exchanger, igniter, control_board.
Rate complexity 1 (quick fix) to 5 (major overhaul). Be practical and specific.`,
});

const quoteAgent = new Agent({
  name: "HVACQuoteAgent",
  model: MODEL,
  instructions: `You are a pricing specialist for Arctic Air HVAC.
Generate clear, professional 2-sentence service quote descriptions.
Labor rate: $95/hr. Returning customer: 10% off labor. Warranty active: 20% off parts.
Be specific about the work being performed and confirm the exact total.`,
});

const emergencyAgent = new Agent({
  name: "HVACEmergencyAgent",
  model: MODEL,
  instructions: `You are an HVAC emergency response specialist.
Prioritize customer safety above all else.
"immediate-hazard" = evacuate or shut off gas/power now.
"monitor-situation" = watch carefully, not immediately dangerous.
"not-dangerous" = comfort issue only.
Provide clear, actionable steps a non-technical homeowner can follow safely.
Be conservative: when in doubt, classify higher.`,
});

const communicationsAgent = new Agent({
  name: "HVACCommunicationsAgent",
  model: MODEL,
  instructions: `You write professional communications for Arctic Air HVAC.
Customer SMS: calming, concise, under 160 characters, always include ETA.
Technician briefings: precise, include address, issue summary, safety notes, customer contact.
Always be clear and professional.`,
});

const reminderAgent = new Agent({
  name: "HVACReminderAgent",
  model: MODEL,
  instructions: `You write friendly appointment reminder SMS messages for HVAC tune-up visits.
Keep under 160 characters. Include: customer name, service type, time slot.
Ask them to reply CONFIRM or CANCEL to reschedule. Warm and professional tone.`,
});

// ============================================================
// Workflow 1: HVAC Service Request Triage
// Patterns: andAgent w/ tool, andThen, andBranch,
//           getStepData, workflowState, andTap
// ============================================================

const serviceRequestWorkflow = createWorkflow(
  {
    id: "hvac-service-request",
    name: "HVAC Service Request Workflow",
    purpose: "Triage incoming HVAC service requests, assign technicians, and generate job tickets",
    input: z.object({
      customerName: z.string().describe("Full name of the customer"),
      phone: z.string().describe("Customer contact phone number"),
      address: z.string().describe("Full service address"),
      issueDescription: z.string().describe("Customer description of the problem"),
      equipmentType: z
        .enum(["central-ac", "heat-pump", "furnace", "mini-split", "commercial-chiller", "boiler"])
        .describe("Type of HVAC equipment"),
      equipmentAge: z.number().optional().describe("Age of equipment in years"),
    }),
    result: z.object({
      ticketId: z.string(),
      customerName: z.string(),
      urgency: z.enum(["emergency", "scheduled", "preventive"]),
      jobType: z.string(),
      assignedTechnician: z.string().nullable(),
      eta: z.string(),
      estimatedCost: z.number().describe("Estimated total in USD"),
      status: z.enum(["dispatched", "scheduled", "queued"]),
      notes: z.string(),
    }),
  },

  andThen({
    id: "init",
    execute: async ({ data, setWorkflowState }) => {
      const ticketId = `TKT-${Date.now().toString(36).toUpperCase()}`;
      console.log(`\n🔧 New service request: ${ticketId}`);
      console.log(`   Customer: ${data.customerName} | ${data.phone}`);
      console.log(`   Equipment: ${data.equipmentType} | Issue: ${data.issueDescription}\n`);
      setWorkflowState((prev) => ({
        ...prev,
        ticketId,
        customerName: data.customerName,
        issueDescription: data.issueDescription,
        equipmentType: data.equipmentType,
        equipmentAge: data.equipmentAge,
      }));
      return { ...data, ticketId };
    },
  }),

  andAgent(
    async ({ data }) => `
      Classify this HVAC service request. Start by calling get_customer_history
      with phone "${data.phone}" to check customer status.

      Customer: ${data.customerName}
      Equipment: ${data.equipmentType}${data.equipmentAge ? `, ${data.equipmentAge} years old` : ""}
      Issue: ${data.issueDescription}

      Return urgency, jobType, requiredSkills, brief reasoning,
      and the isReturningCustomer/warrantyActive values from the history tool.
    `,
    triageAgent,
    {
      schema: z.object({
        urgency: z.enum(["emergency", "scheduled", "preventive"]).describe("Service urgency level"),
        jobType: z
          .enum(["repair", "replacement", "tune-up", "inspection", "installation"])
          .describe("Type of job required"),
        requiredSkills: z.array(z.string()).describe("Technician skills needed"),
        reasoning: z.string().describe("Brief explanation of the classification"),
        isReturningCustomer: z.boolean(),
        warrantyActive: z.boolean(),
      }),
    },
  ),

  andThen({
    id: "dispatch",
    execute: async ({ data, getStepData, setWorkflowState }) => {
      const urgencyEmoji =
        ({ emergency: "🚨", scheduled: "📅", preventive: "🔍" } as Record<string, string>)[
          data.urgency
        ] ?? "📋";
      console.log(`${urgencyEmoji} Triage: ${data.urgency.toUpperCase()} | ${data.jobType}`);
      console.log(`   Skills needed: ${data.requiredSkills.join(", ")}`);
      console.log(`   Reasoning: ${data.reasoning}\n`);

      const availability = await checkTechnicianAvailability(
        data.requiredSkills,
        data.urgency === "emergency",
      );

      setWorkflowState((prev) => ({
        ...prev,
        urgency: data.urgency,
        jobType: data.jobType,
        assignedTechnician: availability.assignedTechnician?.name ?? null,
        eta: availability.eta,
        isReturningCustomer: data.isReturningCustomer,
        warrantyActive: data.warrantyActive,
      }));

      const initData = getStepData("init")?.output;
      return {
        urgency: data.urgency,
        jobType: data.jobType,
        requiredSkills: data.requiredSkills,
        isReturningCustomer: data.isReturningCustomer,
        warrantyActive: data.warrantyActive,
        assignedTechnician: availability.assignedTechnician?.name ?? null,
        eta: availability.eta,
        equipmentType: initData?.equipmentType ?? "",
        equipmentAge: initData?.equipmentAge,
        issueDescription: initData?.issueDescription ?? "",
      };
    },
  }),

  andAgent(
    async ({ data }) => `
      Diagnose this HVAC issue and identify parts likely needed:

      Equipment: ${data.equipmentType}${data.equipmentAge ? ` (${data.equipmentAge} years old)` : ""}
      Urgency: ${data.urgency} | Job type: ${data.jobType}
      Issue reported: ${data.issueDescription}

      List only catalog parts these symptoms specifically indicate.
      Rate job complexity 1 (quick fix) to 5 (major overhaul).
    `,
    diagnosisAgent,
    {
      schema: z.object({
        likelyCause: z.string().describe("Most probable root cause"),
        partsNeeded: z.array(z.string()).describe("Parts from catalog likely required"),
        complexity: z.number().min(1).max(5).describe("Job complexity 1-5"),
        technicianNotes: z.string().describe("Key notes for the assigned technician"),
      }),
    },
  ),

  andThen({
    id: "estimate",
    execute: async ({ data, getStepData }) => {
      const dispatchData = getStepData("dispatch")?.output;
      let estimatedCost = 95;

      if (data.partsNeeded.length > 0) {
        const costData = await getPartsEstimate(data.partsNeeded);
        const laborCost = costData.laborHours * costData.laborRate;
        let partsCost = costData.subtotal;
        let totalLabor = laborCost;
        if (dispatchData?.warrantyActive) partsCost *= 0.8;
        if (dispatchData?.isReturningCustomer) totalLabor *= 0.9;
        estimatedCost = Math.round(partsCost + totalLabor);
      }

      console.log(`📊 Diagnosis: ${data.likelyCause}`);
      console.log(`   Parts: ${data.partsNeeded.join(", ") || "none"}`);
      console.log(`   Estimated cost: $${estimatedCost}\n`);

      return {
        likelyCause: data.likelyCause,
        partsNeeded: data.partsNeeded,
        complexity: data.complexity,
        technicianNotes: data.technicianNotes,
        estimatedCost,
        urgency: dispatchData?.urgency ?? "scheduled",
        jobType: dispatchData?.jobType ?? "repair",
        assignedTechnician: dispatchData?.assignedTechnician ?? null,
        eta: dispatchData?.eta ?? "TBD",
      };
    },
  }),

  andBranch({
    id: "route",
    branches: [
      {
        condition: ({ data }) => data.urgency === "emergency",
        step: andThen({
          id: "emergency-dispatch",
          execute: async ({ data }) => {
            console.log(`🚨 EMERGENCY DISPATCH: ${data.assignedTechnician ?? "on-call tech"} → ETA ${data.eta}`);
            return { ...data, status: "dispatched" as const };
          },
        }),
      },
      {
        condition: ({ data }) => data.urgency === "scheduled",
        step: andThen({
          id: "book-appointment",
          execute: async ({ data }) => {
            console.log(`📅 APPOINTMENT BOOKED: ${data.assignedTechnician ?? "TBD"} → ${data.eta}`);
            return { ...data, status: "scheduled" as const };
          },
        }),
      },
      {
        condition: ({ data }) => data.urgency === "preventive",
        step: andThen({
          id: "queue-maintenance",
          execute: async ({ data }) => {
            console.log(`🔍 PREVENTIVE: Added to seasonal maintenance queue`);
            return { ...data, status: "queued" as const };
          },
        }),
      },
    ],
  }),

  andThen({
    id: "finalize",
    execute: async ({ data, getStepData, workflowState }) => {
      const results = Array.isArray(data) ? data : [data];
      const resolved = results.find((r) => r !== undefined && r !== null) as
        | { status: "dispatched" | "scheduled" | "queued" }
        | undefined;

      const estimateData = getStepData("estimate")?.output;
      const initData = getStepData("init")?.output;

      const ticket = {
        ticketId: workflowState.ticketId as string,
        customerName: initData?.customerName ?? "",
        urgency: (workflowState.urgency as "emergency" | "scheduled" | "preventive") ?? "scheduled",
        jobType: (workflowState.jobType as string) ?? "repair",
        assignedTechnician: (workflowState.assignedTechnician as string | null) ?? null,
        eta: (workflowState.eta as string) ?? "TBD",
        estimatedCost: estimateData?.estimatedCost ?? 95,
        status: resolved?.status ?? "scheduled",
        notes: `${estimateData?.likelyCause ?? "Diagnosis pending"}. Complexity: ${estimateData?.complexity ?? 1}/5. ${estimateData?.technicianNotes ?? ""}`.trim(),
      };

      console.log(`\n✅ Ticket ${ticket.ticketId} | ${ticket.status.toUpperCase()}`);
      console.log(`   Assigned: ${ticket.assignedTechnician ?? "Unassigned"} | ETA: ${ticket.eta}`);
      console.log(`   Estimated cost: $${ticket.estimatedCost}\n`);

      return ticket;
    },
  }),
);

// ============================================================
// Workflow 2: Quote Approval (Suspend/Resume)
// Patterns: suspend/resume, getStepData across agent steps
// ============================================================

const quoteApprovalWorkflow = createWorkflow(
  {
    id: "hvac-quote-approval",
    name: "HVAC Quote Approval Workflow",
    purpose: "Generate quotes with auto-approval under $1,000 and manager sign-off above",
    input: z.object({
      ticketId: z.string().describe("Ticket ID this quote is for"),
      customerName: z.string(),
      jobType: z.string(),
      equipmentType: z.string(),
      issueDescription: z.string(),
      partsNeeded: z.array(z.string()).describe("Parts identified in diagnosis"),
      isReturningCustomer: z.boolean().default(false),
      warrantyActive: z.boolean().default(false),
    }),
    result: z.object({
      quoteId: z.string(),
      ticketId: z.string(),
      status: z.enum(["approved", "pending-approval", "rejected"]),
      totalAmount: z.number(),
      quoteDescription: z.string(),
      approvedBy: z.string(),
    }),
  },

  andThen({
    id: "cost-calculation",
    execute: async ({ data }) => {
      console.log(`\n💰 Generating quote for ${data.ticketId}...`);
      let partsCost = 0;
      let laborHours = 1;
      const breakdown: Record<string, number> = {};

      if (data.partsNeeded.length > 0) {
        const estimate = await getPartsEstimate(data.partsNeeded);
        partsCost = estimate.subtotal;
        laborHours = estimate.laborHours;
        Object.assign(breakdown, estimate.breakdown);
      }

      const laborCost = laborHours * 95;
      const warrantyDiscount = data.warrantyActive ? partsCost * 0.2 : 0;
      const returningDiscount = data.isReturningCustomer ? laborCost * 0.1 : 0;
      const total = Math.round(partsCost + laborCost - warrantyDiscount - returningDiscount);

      return { ...data, breakdown, partsCost, laborHours, laborCost, warrantyDiscount, returningDiscount, subtotal: total };
    },
  }),

  andAgent(
    async ({ data }) => `
      Write a professional 2-sentence service quote description:

      Customer: ${data.customerName}${data.isReturningCustomer ? " (returning — 10% labor discount)" : ""}
      Ticket: ${data.ticketId} | Job: ${data.jobType} on ${data.equipmentType}
      Issue: ${data.issueDescription}
      Parts: ${JSON.stringify(data.breakdown)}
      Labor: ${data.laborHours}h × $95/hr = $${data.laborCost}
      Warranty discount: -$${data.warrantyDiscount}
      Returning customer discount: -$${data.returningDiscount}
      Total: $${data.subtotal}

      Return the description and confirm totalAmount as ${data.subtotal}.
    `,
    quoteAgent,
    {
      schema: z.object({
        quoteDescription: z.string().describe("Professional 2-sentence quote description"),
        totalAmount: z.number().describe("Confirmed total in USD"),
      }),
    },
  ),

  andThen({
    id: "approval-gate",
    resumeSchema: z.object({
      approved: z.boolean().describe("Manager approval decision"),
      managerId: z.string().describe("ID of the approving manager"),
      comments: z.string().optional(),
    }),
    execute: async ({ data, suspend, resumeData, getStepData }) => {
      const calcData = getStepData("cost-calculation")?.output;

      if (resumeData) {
        console.log(
          `\n${resumeData.approved ? "✅" : "❌"} Manager ${resumeData.managerId} ${resumeData.approved ? "approved" : "rejected"} quote`,
        );
        return { ...data, approved: resumeData.approved, approvedBy: resumeData.managerId, managerComments: resumeData.comments };
      }

      if (data.totalAmount > 1000) {
        console.log(`\n⏸️  High-value quote ($${data.totalAmount}) — awaiting manager approval`);
        await suspend("Manager approval required for quotes over $1,000", {
          ticketId: calcData?.ticketId,
          totalAmount: data.totalAmount,
          jobType: calcData?.jobType,
          customerName: calcData?.customerName,
        });
      }

      console.log(`\n✅ Auto-approved (under $1,000 threshold)`);
      return { ...data, approved: true, approvedBy: "system-auto", managerComments: "Auto-approved" };
    },
  }),

  andThen({
    id: "finalize-quote",
    execute: async ({ data, getStepData }) => {
      const calcData = getStepData("cost-calculation")?.output;
      const quoteId = `QTE-${Date.now().toString(36).toUpperCase()}`;
      const status = data.approved ? ("approved" as const) : ("rejected" as const);

      console.log(`\n📄 Quote ${quoteId}: ${status.toUpperCase()} | $${data.totalAmount}`);

      return {
        quoteId,
        ticketId: calcData?.ticketId ?? "",
        status,
        totalAmount: data.totalAmount,
        quoteDescription: data.quoteDescription,
        approvedBy: data.approvedBy,
      };
    },
  }),
);

// ============================================================
// Workflow 3: Seasonal Maintenance Batch
// Patterns: andForEach with concurrency, wrapped agent call
//           inside andThen, andMap aggregation
// ============================================================

const maintenanceBatchWorkflow = createWorkflow(
  {
    id: "hvac-maintenance-batch",
    name: "Seasonal Maintenance Batch Workflow",
    purpose: "Schedule a batch of HVAC units for seasonal tune-ups and generate AI customer reminders",
    input: z.array(
      z.object({
        unitId: z.string(),
        customerName: z.string(),
        address: z.string(),
        equipmentType: z.string(),
        lastServiceDate: z.string().optional(),
      }),
    ),
    result: z.object({
      totalUnits: z.number(),
      scheduled: z.number(),
      totalEstimatedRevenue: z.number(),
      schedule: z.array(
        z.object({
          unitId: z.string(),
          customerName: z.string(),
          appointmentSlot: z.string(),
          estimatedCost: z.number(),
          reminderSMS: z.string().describe("AI-generated SMS reminder to send the customer"),
        }),
      ),
    }),
  },

  andTap({
    id: "log-batch-start",
    execute: async ({ data }) => {
      console.log(`\n📦 Starting maintenance batch for ${Array.isArray(data) ? data.length : 0} units...`);
    },
  }),

  andForEach({
    id: "schedule-units",
    step: andThen({
      id: "assign-slot-and-remind",
      execute: async ({ data }) => {
        const slots = [
          "Mon 8am–10am", "Mon 10am–12pm", "Mon 1pm–3pm",
          "Tue 8am–10am", "Tue 10am–12pm", "Tue 1pm–3pm",
          "Wed 8am–10am", "Wed 10am–12pm",
          "Thu 8am–10am", "Thu 1pm–3pm",
        ];
        const slot = slots[Math.floor(Math.random() * slots.length)] ?? "TBD";
        const tuneUpRate = 149;

        // Wrapped agent call — preserves full data context, generates personalized reminder
        const { text: reminderSMS } = await reminderAgent.generateText(
          `Write a friendly SMS reminder (under 160 chars) for:
           Customer: ${data.customerName}
           Service: Seasonal HVAC tune-up (${data.equipmentType})
           Appointment: ${slot}
           Ask them to reply CONFIRM or CANCEL to reschedule.`,
        );

        console.log(`   📅 ${data.customerName} (${data.equipmentType}) → ${slot}`);

        return {
          unitId: data.unitId,
          customerName: data.customerName,
          appointmentSlot: slot,
          estimatedCost: tuneUpRate,
          reminderSMS: reminderSMS.trim(),
        };
      },
    }),
    concurrency: 2,
  }),

  andMap({
    id: "build-summary",
    map: {
      schedule: { source: "data" },
      totalUnits: { source: "fn", fn: ({ data }) => (Array.isArray(data) ? data.length : 0) },
      scheduled: {
        source: "fn",
        fn: ({ data }) => (Array.isArray(data) ? data.filter((d) => Boolean(d.appointmentSlot)).length : 0),
      },
      totalEstimatedRevenue: {
        source: "fn",
        fn: ({ data }) =>
          Array.isArray(data) ? data.reduce((sum: number, d) => sum + (d.estimatedCost ?? 0), 0) : 0,
      },
    },
  }),

  andTap({
    id: "log-summary",
    execute: async ({ data }) => {
      console.log(`\n✅ Batch scheduled: ${data.scheduled}/${data.totalUnits} units`);
      console.log(`   Estimated revenue: $${data.totalEstimatedRevenue}`);
      if (Array.isArray(data.schedule) && data.schedule[0]) {
        console.log(`\n   Sample reminder: "${data.schedule[0].reminderSMS}"`);
      }
    },
  }),
);

// ============================================================
// Workflow 4: Emergency After-Hours Dispatch
// Patterns: time-based logic, safety AI, multi-output comms
// ============================================================

const emergencyAfterHoursWorkflow = createWorkflow(
  {
    id: "hvac-emergency-afterhours",
    name: "Emergency After-Hours Dispatch",
    purpose:
      "Handle urgent HVAC emergencies with safety assessment, on-call dispatch, and automated communications",
    input: z.object({
      customerName: z.string(),
      phone: z.string(),
      address: z.string(),
      issueDescription: z.string().describe("Description of the emergency"),
      equipmentType: z.enum([
        "central-ac",
        "heat-pump",
        "furnace",
        "mini-split",
        "commercial-chiller",
        "boiler",
      ]),
    }),
    result: z.object({
      ticketId: z.string(),
      customerName: z.string(),
      safetyRisk: z.enum(["immediate-hazard", "monitor-situation", "not-dangerous"]),
      immediateActions: z.array(z.string()).describe("Steps the customer should take right now"),
      onCallTechnician: z.string(),
      eta: z.string(),
      estimatedCost: z.number(),
      customerNotification: z.string().describe("SMS sent to the customer"),
      technicianBrief: z.string().describe("Dispatch briefing for the technician"),
      surgeApplied: z.boolean().describe("Whether after-hours surge pricing (1.5x) applies"),
    }),
  },

  // Step 1: Record intake time and apply surge pricing if after-hours
  andThen({
    id: "intake",
    execute: async ({ data, setWorkflowState }) => {
      const now = new Date();
      const hour = now.getHours();
      const isWeekend = now.getDay() === 0 || now.getDay() === 6;
      const isAfterHours = hour < 7 || hour >= 20 || isWeekend;
      const ticketId = `EMG-${Date.now().toString(36).toUpperCase()}`;
      const surgeMultiplier = isAfterHours ? 1.5 : 1.0;

      console.log(`\n🚨 EMERGENCY INTAKE: ${ticketId}`);
      console.log(`   Time: ${now.toLocaleTimeString()} | After-hours: ${isAfterHours} | Surge: ${surgeMultiplier}x`);
      console.log(`   Customer: ${data.customerName} at ${data.address}\n`);

      setWorkflowState((prev) => ({
        ...prev,
        ticketId,
        customerName: data.customerName,
        isAfterHours,
        surgeMultiplier,
      }));

      return { ...data, ticketId, isAfterHours, surgeMultiplier };
    },
  }),

  // Step 2: AI safety assessment
  andAgent(
    async ({ data }) => `
      Emergency HVAC call — assess the safety risk immediately:

      Equipment: ${data.equipmentType}
      Issue reported: ${data.issueDescription}
      Location: ${data.address}

      Classify safety risk:
      - "immediate-hazard": evacuate or shut off gas/power now
      - "monitor-situation": watch carefully, not immediately dangerous
      - "not-dangerous": comfort issue only

      Also provide 2-4 immediate safe actions for the homeowner,
      technical severity 1-5, and whether a permit will likely be required.

      Be conservative — when in doubt, classify higher.
    `,
    emergencyAgent,
    {
      schema: z.object({
        safetyRisk: z
          .enum(["immediate-hazard", "monitor-situation", "not-dangerous"])
          .describe("Safety risk level"),
        immediateActions: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe("Safe actions for the customer to take now"),
        technicalSeverity: z.number().min(1).max(5),
        requiresPermit: z.boolean(),
      }),
    },
  ),

  // Step 3: Assign on-call technician and calculate emergency rates
  andThen({
    id: "assign-oncall",
    execute: async ({ data, getStepData }) => {
      const intakeData = getStepData("intake")?.output;
      const tech = ON_CALL_ROSTER.find((t) => t.available) ?? ON_CALL_ROSTER[0];
      if (!tech) throw new Error("No on-call technicians available");

      const surgeMultiplier = intakeData?.surgeMultiplier ?? 1.0;
      const estimatedHours = data.technicalSeverity <= 2 ? 1 : 2;
      const estimatedCost = Math.round((150 + 125 * estimatedHours) * surgeMultiplier);

      console.log(`📟 On-call: ${tech.name} | ETA: ${intakeData?.isAfterHours ? "90–120 min" : "45–60 min"}`);
      console.log(`   Cost: $${estimatedCost}${surgeMultiplier > 1 ? " (1.5× surge)" : ""}\n`);

      return {
        safetyRisk: data.safetyRisk,
        immediateActions: data.immediateActions,
        technicalSeverity: data.technicalSeverity,
        requiresPermit: data.requiresPermit,
        onCallTech: tech.name,
        onCallPhone: tech.phone,
        eta: intakeData?.isAfterHours ? "90–120 minutes" : "45–60 minutes",
        estimatedCost,
        isAfterHours: intakeData?.isAfterHours ?? false,
        surgeMultiplier,
        customerName: intakeData?.customerName ?? "",
        phone: intakeData?.phone ?? "",
        address: intakeData?.address ?? "",
        issueDescription: intakeData?.issueDescription ?? "",
        equipmentType: intakeData?.equipmentType ?? "",
      };
    },
  }),

  // Step 4: Generate customer SMS and technician dispatch brief
  andAgent(
    async ({ data }) => `
      Generate two communications for this emergency HVAC dispatch:

      SITUATION:
      Customer: ${data.customerName} at ${data.address}
      Equipment: ${data.equipmentType}
      Issue: ${data.issueDescription}
      Safety risk: ${data.safetyRisk}
      Immediate customer actions: ${data.immediateActions.join("; ")}

      DISPATCH:
      Technician: ${data.onCallTech} (${data.onCallPhone})
      ETA: ${data.eta}
      Cost: $${data.estimatedCost}${data.isAfterHours ? " (after-hours rate)" : ""}
      Permit needed: ${data.requiresPermit}

      1. customerSMS: Calming SMS under 160 chars confirming help is on the way with ETA
      2. technicianBrief: Precise dispatch message with address, issue, safety risk, customer phone
    `,
    communicationsAgent,
    {
      schema: z.object({
        customerSMS: z.string().max(160).describe("Customer notification SMS"),
        technicianBrief: z.string().describe("Dispatch brief for the assigned technician"),
      }),
    },
  ),

  // Step 5: Assemble final emergency ticket
  andThen({
    id: "create-emergency-ticket",
    execute: async ({ data, getStepData, workflowState }) => {
      const oncallData = getStepData("assign-oncall")?.output;

      const ticket = {
        ticketId: workflowState.ticketId as string,
        customerName: workflowState.customerName as string,
        safetyRisk: oncallData?.safetyRisk ?? ("monitor-situation" as const),
        immediateActions: (oncallData?.immediateActions as string[]) ?? [],
        onCallTechnician: oncallData?.onCallTech ?? "On-call dispatch",
        eta: oncallData?.eta ?? "2 hours",
        estimatedCost: oncallData?.estimatedCost ?? 300,
        customerNotification: data.customerSMS,
        technicianBrief: data.technicianBrief,
        surgeApplied: (workflowState.surgeMultiplier as number) > 1,
      };

      console.log(`\n🚨 Emergency ticket: ${ticket.ticketId}`);
      console.log(`   Safety: ${ticket.safetyRisk.toUpperCase()}`);
      console.log(`   Tech: ${ticket.onCallTechnician} | ETA: ${ticket.eta}`);
      console.log(`   Cost: $${ticket.estimatedCost}${ticket.surgeApplied ? " (surge)" : ""}`);
      console.log(`\n   📱 SMS: "${ticket.customerNotification}"\n`);

      return ticket;
    },
  }),
);

// ============================================================
// VoltAgent Server
// ============================================================

const logger = createPinoLogger({ name: "hvac-demo", level: "info" });

new VoltAgent({
  agents: { triageAgent, diagnosisAgent, quoteAgent, emergencyAgent, communicationsAgent, reminderAgent },
  logger,
  server: honoServer({ port: 3141 }),
  workflows: {
    serviceRequestWorkflow,
    quoteApprovalWorkflow,
    maintenanceBatchWorkflow,
    emergencyAfterHoursWorkflow,
  },
});
