import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AYSE, CAN, DENIZ, MERT, OKAN, SELIN, startApp, VELI, type TestApp } from "./test-app.ts";

let app: TestApp;
let p: ReturnType<TestApp["seed"]>;
beforeEach(async () => {
  app = await startApp();
  p = app.seed();
});
afterEach(() => app.close());

const PDF = Buffer.from("%PDF-1.4\n% test\n").toString("base64");

describe("who reads what", () => {
  it("shows everyone the directory, and the personal part only to the person, HR editors and admins", () => {
    const asCan = app.hr.getEmployee(CAN, p.ayse.id);
    expect(asCan).toMatchObject({ name: "Ayşe Yılmaz", department: { name: "Finance" }, manager: { name: "Mert Şahin" }, parts: [] });
    expect(asCan).not.toHaveProperty("personal");
    expect(asCan).not.toHaveProperty("work");

    const asMert = app.hr.getEmployee(MERT, p.ayse.id);
    expect(asMert.parts).toEqual(["work", "leave"]);
    expect(asMert).not.toHaveProperty("personal");

    const asAyse = app.hr.getEmployee(AYSE, p.ayse.id);
    expect(asAyse.parts).toEqual(["work", "personal", "pay", "documents", "leave"]);
    expect(asAyse.personal).toMatchObject({ nationalId: "10000000146", birthDate: "1994-02-14", phone: "+90 532 000 00 12" });
    expect(asAyse.pay).toMatchObject({ iban: "TR330006100519786457841326" });

    // HR editors read pay too: they set it. "viewer" in the file means that role and those above it.
    expect(app.hr.getEmployee(SELIN, p.ayse.id).parts).toEqual(["work", "personal", "pay", "documents", "leave"]);
    // Payroll's viewer token reads pay but not the personal part.
    expect(app.hr.getEmployee(VELI, p.ayse.id).parts).toEqual(["work", "pay", "leave"]);
    expect(app.hr.getEmployee(OKAN, p.ayse.id).parts).toEqual(["work", "personal", "pay", "documents", "leave"]);
  });

  it("lets a manager read down the whole reporting line, never up or across", () => {
    expect(app.hr.getEmployee(MERT, p.deniz.id).parts).toContain("work");
    expect(app.hr.getEmployee(AYSE, p.deniz.id).parts).toContain("work");
    expect(app.hr.getEmployee(DENIZ, p.ayse.id).parts).toEqual([]);
    expect(app.hr.getEmployee(AYSE, p.can.id).parts).toEqual([]);
  });

  it("follows the file: a part given to managers is theirs to read", () => {
    const text = `access: { personal: [self, manager, editor] }`;
    app.hr.setConfig({ ...app.hr.config()!, access: { ...app.hr.config()!.access, personal: ["self", "manager", "editor"] } }, text);
    expect(app.hr.getEmployee(MERT, p.ayse.id).personal).toMatchObject({ phone: "+90 532 000 00 12" });
  });

  it("logs every look beyond the directory, and shows the person who looked", () => {
    app.hr.getEmployee(MERT, p.ayse.id);
    app.hr.getEmployee(CAN, p.ayse.id);
    app.hr.listDocuments(SELIN, p.ayse.id);
    const log = app.hr.accessLog(AYSE, p.ayse.id);
    expect(log.map((l) => [l.by, l.as, l.what, l.parts])).toEqual([
      ["Selin Aydın", "editor", "documents", ["documents"]],
      ["Mert Şahin", "manager", "record", ["work"]],
    ]);
    expect(() => app.hr.accessLog(MERT, p.ayse.id)).toThrow(/for the person and admins/);
    expect(app.hr.accessLog(OKAN, p.ayse.id).length).toBe(2);
  });

  it("lets people change only their own contact details", () => {
    expect(
      app.hr.updateEmployee(AYSE, p.ayse.id, { phone: "+90 533 111 22 33", emergencyContact: { name: "Ali Yılmaz", relation: "brother", phone: "+90 555" } })
        .personal,
    ).toMatchObject({
      phone: "+90 533 111 22 33",
      emergencyContact: { name: "Ali Yılmaz" },
    });
    expect(() => app.hr.updateEmployee(AYSE, p.ayse.id, { iban: "TR330006100519786457841326" })).toThrow(/HR changes iban/);
    expect(() => app.hr.updateEmployee(CAN, p.ayse.id, { phone: "1" })).toThrow(/Only HR/);
    expect(() => app.hr.updateEmployee(MERT, p.ayse.id, { department: p.eng.id })).toThrow(/Only HR/);
  });

  it("keeps people who left from the directory, for HR only", () => {
    app.hr.updateEmployee(SELIN, p.can.id, { endDate: "2026-10-30" });
    expect(app.hr.listEmployees(MERT, new URLSearchParams()).map((e) => e.name)).not.toContain("Can Öztürk");
    expect(() => app.hr.listEmployees(MERT, new URLSearchParams({ status: "left" }))).toThrow(/HR only/);
    expect(app.hr.listEmployees(VELI, new URLSearchParams({ status: "left" })).map((e) => e.name)).toEqual(["Can Öztürk"]);
  });
});

describe("personal data at rest", () => {
  it("keeps no personal value, pay, note or document in clear in the database", () => {
    app.hr.addPay(SELIN, p.ayse.id, { from: "2026-12-01", amount: 85000, currency: "TRY" });
    app.hr.addDocument(SELIN, p.ayse.id, { kind: "contract", name: "İş sözleşmesi", contentType: "application/pdf", content: PDF });
    app.hr.createLeave(SELIN, { employee: p.can.id, type: "sick", startDate: "2026-11-03", endDate: "2026-11-05", note: "Grip, rapor Dr. Kaya" });
    app.hr.updateEmployee(SELIN, p.ayse.id, { address: "Moda Cad. 12, Kadıköy" });
    const dump = JSON.stringify(["employees", "pay", "documents", "leave_requests", "history"].map((t) => app.db.prepare(`SELECT * FROM ${t}`).all()));
    for (const secret of ["10000000146", "TR33", "532 000", "1994-02-14", "85000", "8500000", "Grip", "Moda Cad", "% test"]) expect(dump).not.toContain(secret);
    expect(app.hr.history(SELIN, p.ayse.id).find((h) => h.field === "address")).toMatchObject({ from: null, to: "Moda Cad. 12, Kadıköy", part: "personal" });
  });

  it("refuses a second record with the same T.C. kimlik number, and one that fails its check digits", () => {
    expect(() => app.hr.createEmployee(SELIN, { firstName: "X", lastName: "Y", startDate: "2026-12-01", nationalId: "10000000146" })).toThrow(/someone else's/);
    expect(() => app.hr.createEmployee(SELIN, { firstName: "X", lastName: "Y", startDate: "2026-12-01", nationalId: "10000000145" })).toThrow(/check digits/);
    expect(() => app.hr.createEmployee(SELIN, { firstName: "X", lastName: "Y", startDate: "2026-12-01", iban: "TR330006100519786457841327" })).toThrow(/IBAN/);
  });

  it("shows the history of each part only to those who read it", () => {
    app.hr.updateEmployee(SELIN, p.ayse.id, { phone: "+90 533 000 00 00", department: p.eng.id });
    const asMert = app.hr.history(MERT, p.ayse.id).map((h) => h.field);
    expect(asMert).toContain("department");
    expect(asMert).not.toContain("phone");
    expect(() => app.hr.history(CAN, p.ayse.id)).toThrow(/cannot read/);
  });
});

describe("leave", () => {
  it("goes to the manager, then HR, and emails each in turn and the person at the end", () => {
    const r = app.hr.createLeave(CAN, { type: "unpaid", startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(r).toMatchObject({ status: "pending", days: 5, waitingFor: { kind: "manager", approver: { name: "Mert Şahin" } } });
    expect(app.mails.length).toBe(0);
    return app.hr.flushMail().then(() => {
      expect(app.mails.map((m) => [m.to, m.subject])).toEqual([["mert@example.com", "Leave to approve: Can Öztürk, 2026-11-16 to 2026-11-20"]]);
      expect(() => app.hr.decideLeave(CAN, r.id, {}, "approved")).toThrow(/own leave/);
      expect(() => app.hr.decideLeave(AYSE, r.id, {}, "approved")).toThrow(/does not wait for you/);
      expect(app.hr.listLeave(MERT, new URLSearchParams({ scope: "approvals" })).map((x) => x.id)).toEqual([r.id]);
      const after = app.hr.decideLeave(MERT, r.id, { note: "OK" }, "approved");
      expect(after).toMatchObject({ status: "pending", waitingFor: { kind: "hr" } });
      expect(app.hr.decideLeave(SELIN, r.id, {}, "approved").status).toBe("approved");
    });
  });

  it("goes to HR alone when the person has no manager, and approves at once with an empty rule", () => {
    const r = app.hr.createLeave(MERT, { type: "unpaid", startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(r.steps.map((s) => s.kind)).toEqual(["hr"]);
    app.hr.setConfig({ ...app.hr.config()!, leaveTypes: app.hr.config()!.leaveTypes.map((t) => (t.id === "unpaid" ? { ...t, approval: "none" } : t)) }, "");
    expect(app.hr.createLeave(MERT, { type: "unpaid", startDate: "2026-11-17", endDate: "2026-11-17" }).status).toBe("approved");
  });

  it("counts annual leave against a balance granted on the anniversary, with nothing before the first", () => {
    // Can started on 10 June 2024: his record was added today, so what he earned before is an opening balance.
    expect(() => app.hr.createLeave(CAN, { type: "annual", startDate: "2026-11-16", endDate: "2026-11-20" })).toThrow(/Not enough Annual leave: 0 day/);
    app.hr.adjust(SELIN, p.can.id, { type: "annual", days: 9, note: "Opening balance from the old system" });
    const r = app.hr.createLeave(CAN, { type: "annual", startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(r.days).toBe(5);
    const b = app.hr.balances(CAN, p.can.id).find((x) => x.type === "annual")!;
    expect(b).toMatchObject({ balance: 9, pending: 5, available: 4, next: { date: "2027-06-10", days: 14 } });
    expect(() => app.hr.createLeave(CAN, { type: "annual", startDate: "2026-11-23", endDate: "2026-11-27" })).toThrow(/Not enough/);
    // On the anniversary the third year's 14 days come.
    app.clock.set(Date.parse("2027-06-10T06:00:00Z"));
    expect(app.hr.balances(CAN, p.can.id).find((x) => x.type === "annual")).toMatchObject({ granted: 14, balance: 23 });
  });

  it("refuses overlaps, but not the two halves of one day", () => {
    app.hr.createLeave(SELIN, { employee: p.can.id, type: "unpaid", startDate: "2026-11-16", endDate: "2026-11-16", endHalf: true });
    expect(app.hr.createLeave(SELIN, { employee: p.can.id, type: "unpaid", startDate: "2026-11-16", endDate: "2026-11-17", startHalf: true }).days).toBe(1.5);
    expect(() => app.hr.createLeave(SELIN, { employee: p.can.id, type: "unpaid", startDate: "2026-11-17", endDate: "2026-11-18" })).toThrow(/overlaps/);
    expect(() => app.hr.createLeave(CAN, { type: "marriage", startDate: "2026-11-23", endDate: "2026-11-26" })).toThrow(/at most 3 days/);
    expect(() => app.hr.createLeave(CAN, { type: "unpaid", startDate: "2026-11-21", endDate: "2026-11-22" })).toThrow(/days off or public holidays/);
    expect(() => app.hr.createLeave(MERT, { employee: p.can.id, type: "unpaid", startDate: "2026-11-24", endDate: "2026-11-24" })).toThrow(/your own leave/);
  });

  it("shows colleagues that someone is away on sick leave, but not that it is sick leave", () => {
    app.hr.createLeave(SELIN, { employee: p.can.id, type: "sick", startDate: "2026-11-03", endDate: "2026-11-05", approved: true });
    const q = new URLSearchParams({ from: "2026-11-01", to: "2026-11-30" });
    expect(app.hr.absences(AYSE, q)).toEqual([
      expect.objectContaining({ employee: expect.objectContaining({ name: "Can Öztürk" }), type: null, typeName: null }),
    ]);
    expect(app.hr.absences(MERT, q)[0]).toMatchObject({ type: "sick" });
    expect(app.hr.absences(VELI, q)[0]).toMatchObject({ type: "sick" });
  });

  it("is cancelled by the person before it starts, and by HR after", () => {
    const r = app.hr.createLeave(SELIN, { employee: p.can.id, type: "unpaid", startDate: "2026-11-03", endDate: "2026-11-03", approved: true });
    app.clock.set(Date.parse("2026-11-04T06:00:00Z"));
    expect(() => app.hr.cancelLeave(CAN, r.id)).toThrow(/cancelled by HR/);
    expect(app.hr.cancelLeave(SELIN, r.id).status).toBe("cancelled");
  });

  it("gives Payroll the month's leave days by type, paid or not, with pay and balance", () => {
    app.hr.addPay(SELIN, p.can.id, { from: "2024-06-10", amount: 70000 });
    app.hr.addPay(SELIN, p.can.id, { from: "2026-11-15", amount: 80000.5 });
    app.hr.createLeave(SELIN, { employee: p.can.id, type: "unpaid", startDate: "2026-11-27", endDate: "2026-12-02", approved: true });
    const m = app.hr.payroll(VELI, new URLSearchParams({ month: "2026-11" }));
    const can = m.employees.find((e) => e.id === p.can.id)!;
    expect(can).toMatchObject({
      pay: { amount: 80000.5, currency: "TRY", period: "month" },
      leave: [{ type: "unpaid", paid: false, days: 2 }],
      annualBalance: 0,
    });
    expect(m.employees.map((e) => e.name)).toEqual(expect.arrayContaining(["Mert Şahin", "Can Öztürk"]));
    expect(m.employees.map((e) => e.name)).not.toContain("Ayşe Yılmaz");
    expect(() => app.hr.payroll(CAN, new URLSearchParams())).toThrow(/HR and Payroll/);
    expect(app.hr.accessLog(OKAN, p.can.id)[0]).toMatchObject({ what: "payroll:2026-11", parts: ["work", "pay", "leave"] });
  });
});

describe("documents", () => {
  it("checks the file is what it says, needs an expiry where the kind expires, and warns HR once", async () => {
    expect(() =>
      app.hr.addDocument(SELIN, p.can.id, { kind: "contract", name: "x", contentType: "application/pdf", content: Buffer.from("hello").toString("base64") }),
    ).toThrow(/not a application\/pdf/);
    expect(() => app.hr.addDocument(SELIN, p.can.id, { kind: "work-permit", name: "Permit", contentType: "application/pdf", content: PDF })).toThrow(
      /expiresOn is needed/,
    );
    const d = app.hr.addDocument(CAN, p.can.id, {
      kind: "work-permit",
      name: "Çalışma izni",
      contentType: "application/pdf",
      content: PDF,
      expiresOn: "2026-12-20",
    });
    expect(d).toMatchObject({ expiresSoon: true, expired: false });
    expect(() => app.hr.documentFile(MERT, d.id)).toThrow(/documents part/);
    expect(app.hr.documentFile(CAN, d.id).content.toString("latin1")).toContain("%PDF-");
    expect(app.hr.expiring(SELIN).map((x) => x.id)).toEqual([d.id]);
    await app.hr.tick();
    await app.hr.tick();
    expect(app.mails.filter((m) => m.subject.includes("expires")).map((m) => [m.to, m.subject])).toEqual([
      ["hr@example.com", "Work permit of Can Öztürk expires on 2026-12-20"],
    ]);
  });
});

describe("checklists", () => {
  it("starts joining on the start day and leaving when an end day is set, and moves or cancels it with the day", () => {
    const join = app.hr.checklists(SELIN, p.ayse.id);
    expect(join.map((l) => [l.checklist, l.anchor, l.total])).toEqual([["onboarding", "2026-12-01", 4]]);
    const welcome = join[0]!.tasks.find((t) => t.task === "welcome")!;
    expect(welcome).toMatchObject({ assignee: { name: "Mert Şahin" }, dueDate: "2026-12-01" });
    expect(app.hr.tasks(MERT, false).map((t) => t.task)).toEqual(expect.arrayContaining(["welcome"]));
    expect(() => app.hr.setTask(CAN, welcome.id, true)).toThrow(/not yours/);
    expect(app.hr.setTask(MERT, welcome.id, true).doneBy).toBe("Mert Şahin");

    app.hr.updateEmployee(SELIN, p.can.id, { endDate: "2026-11-30", endReason: "Resigned" });
    let leave = app.hr.checklists(SELIN, p.can.id).find((l) => l.on === "end")!;
    expect(leave).toMatchObject({ anchor: "2026-11-30", identity: { status: "waiting" } });
    expect(leave.tasks.find((t) => t.task === "sgk")!.dueDate).toBe("2026-12-10");
    app.hr.updateEmployee(SELIN, p.can.id, { endDate: "2026-12-15" });
    leave = app.hr.checklists(SELIN, p.can.id).find((l) => l.on === "end")!;
    expect(leave.tasks.find((t) => t.task === "sgk")!.dueDate).toBe("2026-12-25");
    app.hr.updateEmployee(SELIN, p.can.id, { endDate: null });
    expect(app.hr.checklists(SELIN, p.can.id).find((l) => l.on === "end")!.cancelled).toBe(true);
  });
});

describe("Identity", () => {
  it("makes the account on the start morning in the department's group, moves it, and turns it off on the end day", async () => {
    const at = (iso: string) => app.clock.set(Date.parse(iso));
    // Mert and Can work already: their accounts are made in the first round.
    await app.hr.identityRound();
    expect(app.identity.byEmail("can@example.com")).toMatchObject({ active: true, displayName: "Can Öztürk" });
    expect(app.identity.byEmail("ayse@example.com")).toBeUndefined();
    expect([...app.identity.groupByName("Engineering")!.members]).toEqual([app.identity.byEmail("can@example.com")!.id]);
    expect(app.identity.groupByName("Employees")!.members.size).toBe(2);

    // Ayşe starts on 1 December: nothing at 06:59 that morning, her account at 07:00.
    at("2026-12-01T03:59:00Z");
    await app.hr.identityRound();
    expect(app.identity.byEmail("ayse@example.com")).toBeUndefined();
    at("2026-12-01T04:00:00Z");
    await app.hr.identityRound();
    const ayse = app.identity.byEmail("ayse@example.com")!;
    expect(ayse.active).toBe(true);
    expect(app.identity.groupByName("Finance")!.members.has(ayse.id)).toBe(true);

    // A move to Engineering moves her group, and leaves the groups others made alone.
    app.identity.groupByName("Finance")!.members.add("someone-else");
    app.hr.updateEmployee(SELIN, p.ayse.id, { department: p.eng.id });
    await app.hr.identityRound();
    expect(app.identity.groupByName("Finance")!.members.has(ayse.id)).toBe(false);
    expect(app.identity.groupByName("Finance")!.members.has("someone-else")).toBe(true);
    expect(app.identity.groupByName("Engineering")!.members.has(ayse.id)).toBe(true);

    // A new work email changes the same account rather than making another.
    app.hr.updateEmployee(SELIN, p.ayse.id, { workEmail: "ayse.yilmaz@example.com" });
    await app.hr.identityRound();
    expect(app.identity.byEmail("ayse.yilmaz@example.com")!.id).toBe(ayse.id);
    // Mert, Can, Ayşe and Deniz, who started the same day.
    expect(app.identity.users.size).toBe(4);

    // Leaving: on at 17:59 on the end day, off at 18:00.
    app.hr.updateEmployee(SELIN, p.ayse.id, { endDate: "2026-12-18" });
    at("2026-12-18T14:59:00Z");
    await app.hr.identityRound();
    expect(app.identity.byEmail("ayse.yilmaz@example.com")!.active).toBe(true);
    at("2026-12-18T15:00:00Z");
    await app.hr.identityRound();
    expect(app.identity.byEmail("ayse.yilmaz@example.com")!.active).toBe(false);
    expect(app.hr.checklists(SELIN, p.ayse.id).find((l) => l.on === "end")!.identity).toMatchObject({ status: "done", accountId: ayse.id });
    const calls = app.identity.calls.length;
    await app.hr.identityRound();
    expect(app.identity.calls.length).toBe(calls);

    // Coming back: the end day cleared, the account is on again.
    app.hr.updateEmployee(SELIN, p.ayse.id, { endDate: null });
    await app.hr.identityRound();
    expect(app.identity.byEmail("ayse.yilmaz@example.com")!.active).toBe(true);
  });

  it("tries again after a failure, shows why, and says when a group is one Identity keeps by hand", async () => {
    app.identity.state.down = true;
    await app.hr.identityRound();
    expect(app.hr.integrations().identity.failing.map((f) => f.error)).toEqual([
      "Identity answered 503 to the search for the person: Identity is starting.",
      "Identity answered 503 to the search for the person: Identity is starting.",
    ]);
    app.identity.state.down = false;
    await app.hr.identityRound();
    expect(app.identity.byEmail("can@example.com")).toBeUndefined();
    app.clock.advance(61_000);
    app.identity.manualGroup("Engineering");
    await app.hr.identityRound();
    expect(app.identity.byEmail("mert@example.com")!.active).toBe(true);
    expect(app.hr.getEmployee(SELIN, p.can.id).identity).toMatchObject({ error: expect.stringContaining("keeps by hand") });
  });
});

describe("CSV import", () => {
  it("adds and updates people by work email, makes departments and positions, links managers and sets opening balances", () => {
    const csv = [
      "Sicil No;Ad;Soyad;E-posta;Departman;Unvan;Yönetici;İşe Giriş Tarihi;TCKN;Maaş;Yıllık İzin Bakiyesi",
      "1001;Zeynep;Kara;zeynep@example.com;Sales;Account manager;mert@example.com;01.02.2021;;65.000,00;7,5",
      "1002;Burak;Aksoy;burak@example.com;Sales;Account manager;zeynep@example.com;2022-03-15;;;",
      ";Can;Öztürk;can@example.com;Engineering;;;10.06.2024;;;",
      "1004;Bad;Date;bad@example.com;Sales;;;31.02.2024;;;",
    ].join("\n");
    const dry = app.hr.importCsv(SELIN, { csv, dryRun: true });
    expect(dry).toMatchObject({ rows: 4, created: 2, updated: 1, skipped: 1 });
    expect(app.hr.listEmployees(SELIN, new URLSearchParams({ q: "zeynep" }))).toEqual([]);
    const r = app.hr.importCsv(SELIN, { csv });
    expect(r.errors).toEqual([{ row: 5, message: "startDate: 31.02.2024 is not a day such as 2026-12-01 or 01.12.2026." }]);
    const zeynep = app.hr.listEmployees(SELIN, new URLSearchParams({ q: "zeynep" }))[0]!;
    expect(zeynep).toMatchObject({
      department: { name: "Sales" },
      position: { title: "Account manager" },
      manager: { name: "Mert Şahin" },
      work: { number: "1001" },
    });
    expect(app.hr.listEmployees(SELIN, new URLSearchParams({ q: "burak" }))[0]!.manager).toMatchObject({ name: "Zeynep Kara" });
    expect(app.hr.balances(SELIN, zeynep.id).find((b) => b.type === "annual")).toMatchObject({ balance: 7.5 });
    expect(app.hr.listPay(SELIN, zeynep.id)[0]).toMatchObject({ amount: 65000, from: "2021-02-01" });
  });
});

describe("retention", () => {
  it("deletes a record the file's after_leaving after the end day, keeping only that it was deleted", async () => {
    await app.hr.identityRound();
    app.hr.updateEmployee(SELIN, p.can.id, { endDate: "2026-11-30" });
    app.clock.set(Date.parse("2036-11-30T06:00:00Z"));
    await app.hr.tick();
    // Turned off at Identity first; the record goes once the account is off.
    expect(app.identity.byEmail("can@example.com")!.active).toBe(false);
    await app.hr.tick();
    expect(() => app.hr.getEmployee(SELIN, p.can.id)).toThrow(/does not exist/);
    expect(app.db.prepare("SELECT reason FROM purges").all()).toEqual([{ reason: "retention ended" }]);
  });
});
