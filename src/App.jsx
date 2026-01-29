import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ISK mødelokale booking
// - 2-trins flow: vælg lokale -> ugekalender
// - 60 min slots (08:00-17:00), Man-Fre
// - Book ved klik (modal med navn)
// - Slet ved klik på booket slot (bekræftelse)
// - Delt/persisteret storage via Supabase (PostgreSQL)

const ROOMS = [
  "Lokale 301 (22 personer)",
  "Lokale 308 (6 personer)",
  "Lokale 315 (6 personer)",
];

// Danish day abbreviations (Mon-Fri)
const DK_DAY = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"]; // includes weekend for safety
const DK_MONTH = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function formatSlotLabel(startMins) {
  const endMins = startMins + 60;
  return `${minutesToHHMM(startMins)}-${minutesToHHMM(endMins)}`;
}

function toISODate(dateLike) {
  // YYYY-MM-DD in local time
  const d = new Date(dateLike);
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${year}-${month}-${day}`;
}

function addDays(dateLike, days) {
  const d = new Date(dateLike);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(dateLike) {
  const d = new Date(dateLike);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7; // Mon=>0, Tue=>1, ..., Sun=>6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diffToMonday);
  return d;
}

function formatDanishDayLabel(dateLike) {
  const d = new Date(dateLike);
  const jsDay = d.getDay();
  // Convert JS day (Sun=0) to DK_DAY index where Mon=0..Sun=6
  const dkIndex = jsDay === 0 ? 6 : jsDay - 1;
  const dayName = DK_DAY[dkIndex];
  const day = d.getDate();
  const month = DK_MONTH[d.getMonth()];
  return `${dayName} ${day}. ${month}`;
}

function formatWeekRange(mondayLike) {
  const start = new Date(mondayLike);
  const end = addDays(start, 4);
  const sDay = start.getDate();
  const sMonth = DK_MONTH[start.getMonth()];
  const eDay = end.getDate();
  const eMonth = DK_MONTH[end.getMonth()];
  if (start.getMonth() === end.getMonth()) {
    return `${sDay}.–${eDay}. ${sMonth}`;
  }
  return `${sDay}. ${sMonth} – ${eDay}. ${eMonth}`;
}

function buildSlots() {
  const slots = [];
  for (let m = 8 * 60; m < 17 * 60; m += 60) {
    slots.push({ startMins: m, label: formatSlotLabel(m) });
  }
  return slots; // 9 slots
}

function normalizeBookings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (b) =>
        b &&
        typeof b.room === "string" &&
        typeof b.date === "string" &&
        typeof b.startMins === "number" &&
        typeof b.name === "string"
    )
    .map((b) => ({
      room: b.room,
      date: b.date,
      startMins: b.startMins,
      name: b.name.trim(),
    }));
}

function bookingKey(room, date, startMins) {
  return `${room}__${date}__${startMins}`;
}

function App() {
  const slots = useMemo(() => buildSlots(), []);

  const [selectedRoom, setSelectedRoom] = useState(null);
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));

  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create"); // create | delete
  const [activeCell, setActiveCell] = useState(null); // { room, date, startMins }
  const [nameInput, setNameInput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Snapshot til rollback ved delete (mere robust end “const snapshot = bookings”)
  const bookingsSnapshotRef = useRef([]);

  const bookingsIndex = useMemo(() => {
    const map = new Map();
    for (const b of bookings) {
      map.set(bookingKey(b.room, b.date, b.startMins), b);
    }
    return map;
  }, [bookings]);

  useEffect(() => {
    if (!selectedRoom) return;

    let isMounted = true;

    setLoading(true);

    const fetchBookings = async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("*")
        .eq("room", selectedRoom);

      if (error) {
        console.error("Supabase fejl:", error);
        if (isMounted) setLoading(false);
        return;
      }

      const normalized = normalizeBookings(
        (data ?? []).map((b) => ({
          room: b.room,
          date: b.date,
          startMins: b.start_mins,
          name: b.name,
        }))
      );

      if (isMounted) {
        setBookings(normalized);
        setLoading(false);
      }
    };

    fetchBookings();

    // Realtime: undgå filter-strengen (følsom ved mellemrum/parenteser).
    // Lyt på alle ændringer og filtrér i callback.
    const channel = supabase
      .channel("bookings-all")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bookings" },
        (payload) => {
          const changedRoom = payload?.new?.room ?? payload?.old?.room;
          if (changedRoom === selectedRoom) {
            fetchBookings();
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [selectedRoom]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));
  }, [weekStart]);

  function openCreateModal(room, date, startMins) {
    setErrorMsg("");
    setModalMode("create");
    setActiveCell({ room, date, startMins });
    setNameInput("");
    setModalOpen(true);
  }

  function openDeleteModal(room, date, startMins) {
    setErrorMsg("");
    setModalMode("delete");
    setActiveCell({ room, date, startMins });
    setNameInput("");
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setActiveCell(null);
    setNameInput("");
    setErrorMsg("");
  }

  async function confirmCreate() {
    if (!activeCell) return;

    const name = nameInput.trim();
    if (!name) {
      setErrorMsg("Indtast venligst dit navn.");
      return;
    }

    const id = bookingKey(activeCell.room, activeCell.date, activeCell.startMins);
    if (bookingsIndex.has(id)) {
      setErrorMsg("Tidsrummet er allerede booket.");
      return;
    }

    // Optimistisk UI: vis bookingen med det samme
    setBookings((prev) => {
      const next = prev.filter(
        (b) =>
          !(
            b.room === activeCell.room &&
            b.date === activeCell.date &&
            b.startMins === activeCell.startMins
          )
      );
      next.push({
        room: activeCell.room,
        date: activeCell.date,
        startMins: activeCell.startMins,
        name,
      });
      return next;
    });

    try {
      const { error } = await supabase.from("bookings").insert({
        id,
        room: activeCell.room,
        date: activeCell.date,
        start_mins: activeCell.startMins,
        name,
      });

      if (error) throw error;

      closeModal();
    } catch (e) {
      console.error(e);

      // Rollback hvis DB-fejl
      setBookings((prev) =>
        prev.filter(
          (b) =>
            !(
              b.room === activeCell.room &&
              b.date === activeCell.date &&
              b.startMins === activeCell.startMins
            )
        )
      );

      setErrorMsg("Kunne ikke gemme booking. Prøv igen.");
    }
  }

  async function confirmDelete() {
    if (!activeCell) return;

    const id = bookingKey(activeCell.room, activeCell.date, activeCell.startMins);

    // Snapshot til rollback
    bookingsSnapshotRef.current = bookings;

    // Optimistisk UI: fjern med det samme
    setBookings((prev) =>
      prev.filter(
        (b) =>
          !(
            b.room === activeCell.room &&
            b.date === activeCell.date &&
            b.startMins === activeCell.startMins
          )
      )
    );

    try {
      const { error } = await supabase.from("bookings").delete().eq("id", id);

      if (error) throw error;

      closeModal();
    } catch (e) {
      console.error(e);

      // Rollback
      setBookings(bookingsSnapshotRef.current);

      setErrorMsg("Kunne ikke slette booking. Prøv igen.");
    }
  }

  function onClickSlot(dateObj, startMins) {
    if (!selectedRoom) return;
    const date = toISODate(dateObj);
    const key = bookingKey(selectedRoom, date, startMins);
    const existing = bookingsIndex.get(key);
    if (existing) {
      openDeleteModal(selectedRoom, date, startMins);
    } else {
      openCreateModal(selectedRoom, date, startMins);
    }
  }

  function resetToRoomSelection() {
    setSelectedRoom(null);
    setWeekStart(startOfWeekMonday(new Date()));
  }

  const headerSubtitle = useMemo(() => {
    if (!selectedRoom) return null;
    return `${selectedRoom} • Uge ${formatWeekRange(weekStart)}`;
  }, [selectedRoom, weekStart]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200/50 bg-white/80 backdrop-blur-md shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-5">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight sm:text-2xl">
              ISK mødelokale booking
            </h1>
            {headerSubtitle ? (
              <p className="mt-1 truncate text-sm text-slate-500">{headerSubtitle}</p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">
                Vælg et lokale for at se kalenderen.
              </p>
            )}
          </div>

          {selectedRoom ? (
            <button
              onClick={resetToRoomSelection}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium shadow-sm transition hover:bg-slate-50 hover:border-slate-400"
            >
              Tilbage
            </button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {!selectedRoom ? (
          <RoomSelection onSelect={setSelectedRoom} />
        ) : (
          <CalendarView
            loading={loading}
            room={selectedRoom}
            weekStart={weekStart}
            setWeekStart={setWeekStart}
            weekDays={weekDays}
            slots={slots}
            bookingsIndex={bookingsIndex}
            onClickSlot={onClickSlot}
          />
        )}

        <Modal open={modalOpen} onClose={closeModal}>
          {modalMode === "create" ? (
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Bekræft booking</h2>
              <p className="mt-2 text-sm text-slate-600">
                {activeCell ? (
                  <>
                    <span className="font-bold text-slate-900">{activeCell.room}</span>
                    <span className="mx-2 text-slate-400">•</span>
                    {formatDanishDayLabel(activeCell.date)}
                    <span className="mx-2 text-slate-400">•</span>
                    <span className="font-bold text-slate-900">
                      {formatSlotLabel(activeCell.startMins)}
                    </span>
                  </>
                ) : null}
              </p>

              <div className="mt-6">
                <label className="block text-sm font-semibold text-slate-900">Dit navn</label>
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmCreate();
                  }}
                  placeholder="Skriv dit navn"
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm placeholder-slate-400 transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
                  autoFocus
                />
              </div>

              {errorMsg ? <p className="mt-3 text-sm font-medium text-red-600">{errorMsg}</p> : null}

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  onClick={closeModal}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 hover:border-slate-400 active:scale-95"
                >
                  Annuller
                </button>
                <button
                  onClick={confirmCreate}
                  className="rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-md transition hover:shadow-lg hover:to-blue-700 active:scale-95"
                >
                  Book
                </button>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Slet booking?</h2>
              <p className="mt-2 text-sm text-slate-600">
                {activeCell ? (
                  <>
                    <span className="font-bold text-slate-900">{activeCell.room}</span>
                    <span className="mx-2 text-slate-400">•</span>
                    {formatDanishDayLabel(activeCell.date)}
                    <span className="mx-2 text-slate-400">•</span>
                    <span className="font-bold text-slate-900">
                      {formatSlotLabel(activeCell.startMins)}
                    </span>
                  </>
                ) : null}
              </p>

              <div className="mt-6 rounded-lg border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Booket af</div>
                <div className="mt-2 text-lg font-bold text-slate-900">
                  {activeCell
                    ? bookingsIndex.get(bookingKey(activeCell.room, activeCell.date, activeCell.startMins))?.name ??
                      "(ukendt)"
                    : ""}
                </div>
              </div>

              {errorMsg ? <p className="mt-3 text-sm font-medium text-red-600">{errorMsg}</p> : null}

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  onClick={closeModal}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 hover:border-slate-400 active:scale-95"
                >
                  Fortryd
                </button>
                <button
                  onClick={confirmDelete}
                  className="rounded-lg bg-gradient-to-r from-red-500 to-red-600 px-4 py-2.5 text-sm font-medium text-white shadow-md transition hover:shadow-lg hover:to-red-700 active:scale-95"
                >
                  Slet
                </button>
              </div>
            </div>
          )}
        </Modal>

        <footer className="mt-12 border-t border-slate-200/50 pt-6 text-center text-xs text-slate-500">
          <p>
            Data er gemt i <span className="font-medium text-slate-600">Supabase (PostgreSQL)</span>
          </p>
        </footer>
      </main>
    </div>
  );
}

function RoomSelection({ onSelect }) {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight">Vælg lokale</h2>
        <p className="mt-2 text-base text-slate-600">Alle bookinger er synlige for alle med linket.</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        {ROOMS.map((room) => (
          <button
            key={room}
            onClick={() => onSelect(room)}
            className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 p-6 text-left shadow-lg transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl focus:outline-none active:scale-95"
          >
            <div
              className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{
                background: "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.15), transparent 50%)",
              }}
            />
            <div className="relative">
              <div className="text-sm font-medium text-blue-100">Mødelokale</div>
              <div className="mt-2 text-xl font-bold text-white">{room}</div>
              <div className="mt-5 inline-flex items-center gap-2 rounded-lg bg-white/15 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm ring-1 ring-white/20 transition group-hover:bg-white/20">
                Åbn kalender
                <span className="transition duration-300 group-hover:translate-x-1">→</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-slate-200/60 bg-white p-6 shadow-sm">
        <div className="text-base font-semibold text-slate-900">Sådan virker det</div>
        <ul className="mt-3 space-y-2 text-sm text-slate-600">
          <li className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-600 flex-shrink-0">
              1
            </span>
            <span>Klik på et ledigt tidsrum og indtast dit navn.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-600 flex-shrink-0">
              2
            </span>
            <span>Bookede tider vises med navn.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-600 flex-shrink-0">
              3
            </span>
            <span>Klik på en booking for at slette den.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function CalendarView({
  loading,
  room,
  weekStart,
  setWeekStart,
  weekDays,
  slots,
  bookingsIndex,
  onClickSlot,
}) {
  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{room}</h2>
          <p className="mt-2 text-slate-600">Klik for at booke eller slette et tidsrum.</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:bg-slate-50 hover:border-slate-400 active:scale-95"
            aria-label="Forrige uge"
            title="Forrige uge"
          >
            ←
          </button>
          <div className="min-w-[180px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium shadow-sm">
            {formatWeekRange(weekStart)}
          </div>
          <button
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:bg-slate-50 hover:border-slate-400 active:scale-95"
            aria-label="Næste uge"
            title="Næste uge"
          >
            →
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-lg">
        {/* Desktop/Tablet grid */}
        <div className="hidden md:block">
          <div className="grid grid-cols-6 border-b bg-gradient-to-r from-slate-50 to-slate-100">
            <div className="px-4 py-4 text-xs font-semibold uppercase tracking-widest text-slate-500">Tid</div>
            {weekDays.map((d) => (
              <div key={toISODate(d)} className="px-4 py-4 text-center text-sm font-bold text-slate-900">
                {formatDanishDayLabel(d)}
              </div>
            ))}
          </div>

          <div className="max-h-[70vh] overflow-auto">
            {slots.map((s) => (
              <div
                key={s.startMins}
                className="grid grid-cols-6 border-b border-slate-100 hover:bg-slate-50/50 transition-colors last:border-b-0"
              >
                <div className="flex items-center justify-start px-4 py-3 text-sm font-semibold text-slate-700 bg-slate-50/30">
                  {s.label}
                </div>

                {weekDays.map((d) => {
                  const date = toISODate(d);
                  const key = bookingKey(room, date, s.startMins);
                  const existing = bookingsIndex.get(key);
                  return (
                    <SlotCell
                      key={key}
                      existing={existing}
                      onClick={() => onClickSlot(d, s.startMins)}
                      ariaLabel={`${formatDanishDayLabel(d)} ${s.label}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Mobile layout: day cards */}
        <div className="md:hidden">
          <div className="px-4 py-3 text-sm text-slate-500">
            <span className="font-medium text-slate-700">Tip:</span> Rul ned for dage og tider.
          </div>
          <div className="space-y-4 p-4">
            {weekDays.map((d) => {
              const date = toISODate(d);
              return (
                <div key={date} className="overflow-hidden rounded-xl border border-slate-200/60 shadow-sm">
                  <div className="bg-gradient-to-r from-slate-50 to-slate-100 px-4 py-3 text-sm font-bold text-slate-900">
                    {formatDanishDayLabel(d)}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {slots.map((s) => {
                      const key = bookingKey(room, date, s.startMins);
                      const existing = bookingsIndex.get(key);
                      return (
                        <div key={key} className="flex items-stretch hover:bg-slate-50/50 transition-colors">
                          <div className="w-24 shrink-0 px-3 py-3 text-xs font-medium text-slate-600 bg-slate-50/40 flex items-center">
                            {s.label}
                          </div>
                          <div className="flex-1 p-2">
                            <SlotCell
                              existing={existing}
                              onClick={() => onClickSlot(d, s.startMins)}
                              ariaLabel={`${formatDanishDayLabel(d)} ${s.label}`}
                              compact
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <Legend loading={loading} />
      </div>
    </div>
  );
}

function SlotCell({ existing, onClick, ariaLabel, compact = false }) {
  if (existing) {
    return (
      <button
        onClick={onClick}
        className={`w-full rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 px-3 py-2 text-left text-sm font-semibold text-white shadow-md transition-all duration-200 hover:shadow-lg hover:to-blue-700 active:scale-95 ${
          compact ? "min-h-[44px]" : "m-2"
        }`}
        aria-label={`Booket: ${ariaLabel}`}
        title="Klik for at slette"
      >
        {existing.name}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 transition-all duration-200 hover:border-blue-400 hover:bg-blue-50 active:scale-95 ${
        compact ? "min-h-[44px]" : "m-2"
      }`}
      aria-label={`Ledig: ${ariaLabel}`}
      title="Klik for at booke"
    >
      Ledig
    </button>
  );
}

function Legend({ loading }) {
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="flex items-center gap-3">
        <div className="h-8 w-16 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50" />
        <span className="text-sm font-medium text-slate-700">Ledig</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-8 w-16 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 shadow-md" />
        <span className="text-sm font-medium text-slate-700">Booket</span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded-full border-2 border-blue-300 border-t-blue-600 animate-spin" />
          <span className="text-sm text-slate-500">Indlæser…</span>
        </div>
      ) : null}
    </div>
  );
}

function Modal({ open, onClose, children }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl transform transition-all duration-200 scale-100">
        {children}
      </div>
    </div>
  );
}

export default App;
