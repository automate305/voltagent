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
// Mock Data (simulates real HVAC company database)
// ============================================================

const TECHNICIANS = [
  { id: "T001", name: "Maria Garcia", skills: ["residential", "commercial", "refrigerant"], available: true },
  { id: "T002", name: "James Wilson", skills: ["residential", "ductwork", "electrical"], available: true },
  { id: "T003", name: "Sarah Chen", skills: ["commercial", "chillers", "refrigerant"], available: false },
  { id: "T004", name: "Mike Torres", skills: ["residential", "heat-pump", "tune-up"], available: true },
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
  "5551234": {
    customerId: "CUST-8821",
    lastService: "2024-11-15",
    warrantyActive: true,
    visits: 4,
    notes: "Prefers morning appointments",
  },
  "5559876": {
    customerId: "CUST-4402",
    lastService: "2023-06-20",
    warrantyActive: false,
    visits: 2,
    notes: "",
  },
};

// ============================================================
// Tools
// ============================================================

/**
 * Attached to triageAgent so the AI can look up customer history
 * before classifying urgency and job type.
 */
const getCustomerHistoryTool = createTool({
  name: "get_customer_history",
  description: "Look up a customer's service history and warranty status by phone number",
  parameters: z.object({
    phone: z.string().describe("Customer phone number"),
  }),
  execute: async ({ phone }) => {
    const digits = phone.replace(/\D/g, "").slice(-7);
    const record = CUSTOMER_DB[digits];

    if (record) {
      return {
        found: true,
        ...record,
        isReturningCustomer: true,
      };
    }

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

/**
 * Called directly in workflow steps (not via agent) for technician dispatch.
 */
async function checkTechnicianAvailability(requiredSkills: string[], isEmergency: boolean) {
  const matches = TECHNICIANS.filter(
    (t) =>
      t.available &&
      (requiredSkills.length === 0 || requiredSkills.some((s) => t.skills.includes(s))),
  );

  const assigned = matches[0] ?? null;

  return {
    technicianAvailable: matches.length > 0,
    assignedTechnician: assigned ? { id: assigned.id, name: assigned.name } : null,
    eta: isEmergency ? "60–90 minutes" : "Today 2pm–5pm",
    allAvailable: matches.map((t) => t.name),
  };
}

/**
 * Called directly in workflow steps to get parts pricing.
 */
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
// ============================================================

const triageAgent = new Agent({
  name: "HVACTriageAgent",
  model: "openai/gpt-4o-mini",
  instructions: `You are an experienced HVAC service coordinator at Arctic Air HVAC.
Assess incoming service requests by:
1. Calling get_customer_history with the customer's phone number first
2. Classifying urgency: "emergency" (no AC/heat, safety risk), "scheduled" (degraded performance), "preventive" (routine maintenance)
3. Identifying jobType: "repair", "replacement", "tune-up", "inspection", or "installation"
4. Listing requiredSkills from: ["residential", "commercial", "refrigerant", "electrical", "ductwork", "heat-pump", "chillers", "tune-up"]
Always call the history tool before responding.`,
  tools: [getCustomerHistoryTool],
});

const diagnosisAgent = new Agent({
  name: "HVACDiagnosisAgent",
  model: "openai/gpt-4o-mini",
  instructions: `You are a senior HVAC technician with 15+ years of field experience.
Diagnose HVAC issues based on reported symptoms. Identify the most likely root cause
and list only the specific parts from this catalog that the symptoms genuinely indicate:
compressor, condenser_fan_motor, capacitor, contactor, refrigerant_r410a,
filter_replacement, thermostat, blower_motor, evaporator_coil, heat_exchanger, igniter, control_board.
Rate complexity 1 (quick fix) to 5 (major overhaul).`,
});

const quoteAgent = new Agent({
  name: "HVACQuoteAgent",
  model: "openai/gpt-4o-mini",
  instructions: `You are a pricing specialist for Arctic Air HVAC.
Generate clear, professional 2-sentence service quote descriptions.
Labor rate: $95/hr. Returning customer: 10% off labor. Warranty active: 20% off parts.
Be specific about the work being performed and confirm the total.`,
});

// ============================================================
// Workflow 1: HVAC Service Request Triage
// Showcases: andAgent (with tool use), andThen, andBranch,
//            getStepData, workflowState, andTap
// ============================================================

const serviceRequestWorkflow = createWorkflow(
  {
    id: "hvac-service-request",
    name: "HVAC Service Request Workflow",
    purpose:
      "Triage incoming HVAC service requests, assign technicians, and generate job tickets",
    input: z.object({
      customerName: z.string(),
      phone: z.string(),
      address: z.string(),
      issueDescription: z.string(),
      equipmentType: z.enum([
        "central-ac",
        "heat-pump",
        "furnace",
        "mini-split",
        "commercial-chiller",
        "boiler",
      ]),
      equipmentAge: z.number().optional(),
    }),
    result: z.object({
      ticketId: z.string(),
      customerName: z.string(),
      urgency: z.enum(["emergency", "scheduled", "preventive"]),
      jobType: z.string(),
      assignedTechnician: z.string().nullable(),
      eta: z.string(),
      estimatedCost: z.number(),
      status: z.enum(["dispatched", "scheduled", "queued"]),
      notes: z.string(),
    }),
  },

  // Step 1: Generate ticket ID and persist key fields in workflow state
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

  // Step 2: AI triage — agent calls get_customer_history tool, then classifies
  andAgent(
    async ({ data }) => `
      Classify this HVAC service request. Start by calling get_customer_history
      with phone "${data.phone}" to check customer status.

      Request details:
      Customer: ${data.customerName}
      Equipment: ${data.equipmentType}${data.equipmentAge ? `, ${data.equipmentAge} years old` : ""}
      Issue: ${data.issueDescription}

      Return urgency, jobType, requiredSkills, your reasoning,
      and the isReturningCustomer/warrantyActive values from the history lookup.
    `,
    triageAgent,
    {
      schema: z.object({
        urgency: z.enum(["emergency", "scheduled", "preventive"]),
        jobType: z.enum(["repair", "replacement", "tune-up", "inspection", "installation"]),
        requiredSkills: z.array(z.string()),
        reasoning: z.string(),
        isReturningCustomer: z.boolean(),
        warrantyActive: z.boolean(),
      }),
    },
  ),

  // Step 3: Log triage result and dispatch a technician
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

      // Retrieve init data to carry essential fields forward to diagnosisAgent
      const initData = getStepData("init")?.output;

      return {
        urgency: data.urgency,
        jobType: data.jobType,
        requiredSkills: data.requiredSkills,
        isReturningCustomer: data.isReturningCustomer,
        warrantyActive: data.warrantyActive,
        assignedTechnician: availability.assignedTechnician?.name ?? null,
        eta: availability.eta,
        // Carry forward fields the diagnosis agent needs
        equipmentType: initData?.equipmentType ?? "",
        equipmentAge: initData?.equipmentAge,
        issueDescription: initData?.issueDescription ?? "",
      };
    },
  }),

  // Step 4: AI diagnosis — root cause and parts needed
  andAgent(
    async ({ data }) => `
      Diagnose this HVAC issue and identify parts likely needed:

      Equipment: ${data.equipmentType}${data.equipmentAge ? ` (${data.equipmentAge} years old)` : ""}
      Urgency: ${data.urgency}
      Job type: ${data.jobType}
      Customer reported: ${data.issueDescription}

      List only parts specifically indicated by these symptoms.
      Rate the job complexity from 1 (quick fix) to 5 (major overhaul).
    `,
    diagnosisAgent,
    {
      schema: z.object({
        likelyCause: z.string(),
        partsNeeded: z.array(z.string()),
        complexity: z.number().min(1).max(5),
        technicianNotes: z.string(),
      }),
    },
  ),

  // Step 5: Calculate estimated cost with applicable discounts
  andThen({
    id: "estimate",
    execute: async ({ data, getStepData }) => {
      const dispatchData = getStepData("dispatch")?.output;

      let estimatedCost = 95; // base service call fee

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

  // Step 6: Branch by urgency to set status
  andBranch({
    id: "route",
    branches: [
      {
        condition: ({ data }) => data.urgency === "emergency",
        step: andThen({
          id: "emergency-dispatch",
          execute: async ({ data }) => {
            console.log(
              `🚨 EMERGENCY DISPATCH: ${data.assignedTechnician ?? "on-call tech"} → ETA ${data.eta}`,
            );
            return { ...data, status: "dispatched" as const };
          },
        }),
      },
      {
        condition: ({ data }) => data.urgency === "scheduled",
        step: andThen({
          id: "book-appointment",
          execute: async ({ data }) => {
            console.log(
              `📅 APPOINTMENT BOOKED: ${data.assignedTechnician ?? "TBD"} → ${data.eta}`,
            );
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

  // Step 7: Assemble the final job ticket
  andThen({
    id: "finalize",
    execute: async ({ data, getStepData, workflowState }) => {
      // andBranch returns an array — select the resolved branch
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
        notes: `${estimateData?.likelyCause ?? "Diagnosis pending"}. Complexity: ${estimateData?.complexity ?? 1}/5. ${estimateData?.technicianNotes ?? ""}`,
      };

      console.log(`\n✅ Job ticket created: ${ticket.ticketId}`);
      console.log(
        `   Status: ${ticket.status.toUpperCase()} | Urgency: ${ticket.urgency.toUpperCase()}`,
      );
      console.log(
        `   Assigned: ${ticket.assignedTechnician ?? "Unassigned"} | ETA: ${ticket.eta}`,
      );
      console.log(`   Estimated cost: $${ticket.estimatedCost}\n`);

      return ticket;
    },
  }),
);

// ============================================================
// Workflow 2: Quote Generation & Manager Approval
// Showcases: suspend/resume, getStepData across agent steps
// ============================================================

const quoteApprovalWorkflow = createWorkflow(
  {
    id: "hvac-quote-approval",
    name: "HVAC Quote Approval Workflow",
    purpose:
      "Generate service quotes with auto-approval under $1,000 and manager sign-off above",
    input: z.object({
      ticketId: z.string(),
      customerName: z.string(),
      jobType: z.string(),
      equipmentType: z.string(),
      issueDescription: z.string(),
      partsNeeded: z.array(z.string()),
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

  // Step 1: Calculate parts and labor costs
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

      return {
        ...data,
        breakdown,
        partsCost,
        laborHours,
        laborCost,
        warrantyDiscount,
        returningDiscount,
        subtotal: total,
      };
    },
  }),

  // Step 2: AI generates a professional quote description
  andAgent(
    async ({ data }) => `
      Write a professional 2-sentence service quote description for:

      Customer: ${data.customerName}${data.isReturningCustomer ? " (returning customer — 10% labor discount applied)" : ""}
      Ticket: ${data.ticketId}
      Work: ${data.jobType} on ${data.equipmentType}
      Issue: ${data.issueDescription}
      Parts breakdown: ${JSON.stringify(data.breakdown)}
      Labor: ${data.laborHours}h × $95/hr = $${data.laborCost}
      Warranty discount: -$${data.warrantyDiscount}
      Returning customer discount: -$${data.returningDiscount}
      Total: $${data.subtotal}

      Return the description and confirm totalAmount as ${data.subtotal}.
    `,
    quoteAgent,
    {
      schema: z.object({
        quoteDescription: z.string(),
        totalAmount: z.number(),
      }),
    },
  ),

  // Step 3: Approval gate — suspend if quote > $1,000
  andThen({
    id: "approval-gate",
    resumeSchema: z.object({
      approved: z.boolean(),
      managerId: z.string(),
      comments: z.string().optional(),
    }),
    execute: async ({ data, suspend, resumeData, getStepData }) => {
      const calcData = getStepData("cost-calculation")?.output;

      if (resumeData) {
        console.log(
          `\n${resumeData.approved ? "✅" : "❌"} Manager ${resumeData.managerId} ${resumeData.approved ? "approved" : "rejected"} quote`,
        );
        return {
          ...data,
          approved: resumeData.approved,
          approvedBy: resumeData.managerId,
          managerComments: resumeData.comments,
        };
      }

      if (data.totalAmount > 1000) {
        console.log(
          `\n⏸️  High-value quote ($${data.totalAmount}) suspended — awaiting manager approval`,
        );
        await suspend("Manager approval required for quotes over $1,000", {
          ticketId: calcData?.ticketId,
          totalAmount: data.totalAmount,
          jobType: calcData?.jobType,
          customerName: calcData?.customerName,
        });
      }

      console.log(`\n✅ Auto-approved (under $1,000 threshold)`);
      return {
        ...data,
        approved: true,
        approvedBy: "system-auto",
        managerComments: "Auto-approved (under $1,000 threshold)",
      };
    },
  }),

  // Step 4: Finalize and return the quote
  andThen({
    id: "finalize-quote",
    execute: async ({ data, getStepData }) => {
      const calcData = getStepData("cost-calculation")?.output;
      const quoteId = `QTE-${Date.now().toString(36).toUpperCase()}`;

      const status = data.approved
        ? ("approved" as const)
        : ("rejected" as const);

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
// Workflow 3: Seasonal Maintenance Batch Scheduler
// Showcases: andForEach (parallel processing) + andMap
// ============================================================

const maintenanceBatchWorkflow = createWorkflow(
  {
    id: "hvac-maintenance-batch",
    name: "Seasonal Maintenance Batch Workflow",
    purpose: "Schedule a batch of HVAC units for seasonal tune-ups with parallel processing",
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
        }),
      ),
    }),
  },

  // Schedule each unit in parallel (up to 3 concurrent)
  andForEach({
    id: "schedule-units",
    step: andThen({
      id: "assign-slot",
      execute: async ({ data }) => {
        const slots = [
          "Mon 8am–10am",
          "Mon 10am–12pm",
          "Mon 1pm–3pm",
          "Tue 8am–10am",
          "Tue 10am–12pm",
          "Tue 1pm–3pm",
          "Wed 8am–10am",
          "Wed 10am–12pm",
          "Thu 8am–10am",
          "Thu 1pm–3pm",
        ];

        const slot = slots[Math.floor(Math.random() * slots.length)];
        const tuneUpRate = 149;

        console.log(`   📅 ${data.customerName} (${data.equipmentType}) → ${slot}`);

        return {
          unitId: data.unitId,
          customerName: data.customerName,
          appointmentSlot: slot ?? "TBD",
          estimatedCost: tuneUpRate,
        };
      },
    }),
    concurrency: 3,
  }),

  // Aggregate into a schedule summary
  andMap({
    id: "build-summary",
    map: {
      schedule: { source: "data" },
      totalUnits: {
        source: "fn",
        fn: ({ data }) => (Array.isArray(data) ? data.length : 0),
      },
      scheduled: {
        source: "fn",
        fn: ({ data }) =>
          Array.isArray(data) ? data.filter((d) => Boolean(d.appointmentSlot)).length : 0,
      },
      totalEstimatedRevenue: {
        source: "fn",
        fn: ({ data }) =>
          Array.isArray(data)
            ? data.reduce((sum: number, d) => sum + (d.estimatedCost ?? 0), 0)
            : 0,
      },
    },
  }),

  andTap({
    id: "log-summary",
    execute: async ({ data }) => {
      console.log(`\n✅ Maintenance batch scheduled:`);
      console.log(`   Units: ${data.scheduled}/${data.totalUnits}`);
      console.log(`   Estimated revenue: $${data.totalEstimatedRevenue}`);
    },
  }),
);

// ============================================================
// VoltAgent Server
// ============================================================

const logger = createPinoLogger({ name: "hvac-demo", level: "info" });

new VoltAgent({
  agents: {
    triageAgent,
    diagnosisAgent,
    quoteAgent,
  },
  logger,
  server: honoServer({ port: 3141 }),
  workflows: {
    serviceRequestWorkflow,
    quoteApprovalWorkflow,
    maintenanceBatchWorkflow,
  },
});
