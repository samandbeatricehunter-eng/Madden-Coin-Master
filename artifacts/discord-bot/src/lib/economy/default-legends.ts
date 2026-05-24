/**
 * Master legend catalog — seeded into new servers on /initialize-server
 * and available via /legend seed-defaults.
 *
 * cost defaults to 1000 if omitted.
 */
export interface LegendSeed {
  name: string;
  position: string;
}

export const DEFAULT_LEGENDS: LegendSeed[] = [
  // ── Quarterbacks ─────────────────────────────────────────────────────────────
  { name: "Warren Moon",          position: "QB" },
  { name: "Dan Marino",           position: "QB" },
  { name: "Ben Roethlisberger",   position: "QB" },
  { name: "Joe Montana",          position: "QB" },
  { name: "Michael Vick",         position: "QB" },
  { name: "Steve Young",          position: "QB" },
  { name: "Peyton Manning",       position: "QB" },
  { name: "Tom Brady",            position: "QB" },
  { name: "Troy Aikman",          position: "QB" },
  { name: "John Elway",           position: "QB" },

  // ── Halfbacks ─────────────────────────────────────────────────────────────────
  { name: "Emmitt Smith",         position: "HB" },
  { name: "Marshall Faulk",       position: "HB" },
  { name: "Adrian Peterson",      position: "HB" },
  { name: "Barry Sanders",        position: "HB" },
  { name: "Walter Payton",        position: "HB" },
  { name: "O.J. Simpson",         position: "HB" },
  { name: "LaDanian Tomlinson",   position: "HB" },
  { name: "Eric Dickerson",       position: "HB" },
  { name: "Tony Dorsett",         position: "HB" },
  { name: "Jim Brown",            position: "HB" },

  // ── Fullbacks ─────────────────────────────────────────────────────────────────
  { name: "Lorenzo Neal",         position: "FB" },
  { name: "Daryl Johnston",       position: "FB" },
  { name: "Larry Csonka",         position: "FB" },
  { name: "Mike Alstott",         position: "FB" },
  { name: "Larry Centers",        position: "FB" },
  { name: "Jim Taylor",           position: "FB" },

  // ── Wide Receivers ───────────────────────────────────────────────────────────
  { name: "Michael Irvin",        position: "WR" },
  { name: "Larry Fitzgerald",     position: "WR" },
  { name: "Cris Carter",          position: "WR" },
  { name: "Steve Largent",        position: "WR" },
  { name: "Jerry Rice",           position: "WR" },
  { name: "Terrell Owens",        position: "WR" },
  { name: "Randy Moss",           position: "WR" },
  { name: "Calvin Johnson",       position: "WR" },
  { name: "Devin Hester",         position: "WR" },
  { name: "Andre Johnson",        position: "WR" },

  // ── Tight Ends ───────────────────────────────────────────────────────────────
  { name: "Tony Gonzalez",        position: "TE" },
  { name: "Rob Gronkowski",       position: "TE" },
  { name: "Antonio Gates",        position: "TE" },
  { name: "Mike Ditka",           position: "TE" },
  { name: "Jason Witten",         position: "TE" },
  { name: "Greg Olsen",           position: "TE" },
  { name: "Shannon Sharpe",       position: "TE" },
  { name: "Jimmy Graham",         position: "TE" },

  // ── Offensive Line ───────────────────────────────────────────────────────────
  { name: "Anthony Munoz",        position: "OL" },
  { name: "Jim Parker",           position: "OL" },
  { name: "John Madden",          position: "OL" },
  { name: "Larry Allen",          position: "OL" },
  { name: "Jonathan Ogden",       position: "OL" },
  { name: "Forrest Gregg",        position: "OL" },
  { name: "Mike Webster",         position: "OL" },
  { name: "Jim Otto",             position: "OL" },
  { name: "Orlando Pace",         position: "OL" },

  // ── Defensive Backs ──────────────────────────────────────────────────────────
  { name: "Ronnie Lott",          position: "DB" },
  { name: "Paul Krause",          position: "DB" },
  { name: "Steve Atwater",        position: "DB" },
  { name: "Rod Woodson",          position: "DB" },
  { name: "Champ Bailey",         position: "DB" },
  { name: "Charles Woodson",      position: "DB" },
  { name: "Night Train Lane",     position: "DB" },
  { name: "Deion Sanders",        position: "DB" },
  { name: "Darrelle Revis",       position: "DB" },
  { name: "Mike Haynes",          position: "DB" },
  { name: "Troy Polamalu",        position: "DB" },
  { name: "Sean Taylor",          position: "DB" },
  { name: "Brian Dawkins",        position: "DB" },
  { name: "Ed Reed",              position: "DB" },
  { name: "Mel Renfro",           position: "DB" },

  // ── Linebackers ──────────────────────────────────────────────────────────────
  { name: "Ray Lewis",            position: "LB" },
  { name: "Dick Butkus",          position: "LB" },
  { name: "Jack Lambert",         position: "LB" },
  { name: "Mike Singletary",      position: "LB" },
  { name: "Ted Hendricks",        position: "LB" },
  { name: "Jack Ham",             position: "LB" },
  { name: "Lawrence Taylor",      position: "LB" },
  { name: "Luke Kuechly",         position: "LB" },

  // ── Defensive Line ───────────────────────────────────────────────────────────
  { name: "Bob Lilly",            position: "DL" },
  { name: "Alan Page",            position: "DL" },
  { name: "Mean Joe Greene",      position: "DL" },
  { name: "Deacon Jones",         position: "DL" },
  { name: "Reggie White",         position: "DL" },
  { name: "Too Tall Jones",       position: "DL" },
  { name: "Bruce Smith",          position: "DL" },
  { name: "Aaron Donald",         position: "DL" },
];
