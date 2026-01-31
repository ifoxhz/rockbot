export function nowISO() {
  return new Date().toISOString();
}

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

