export function normalizePhoneNumber(input, defaultCountryCode = "+81") {
  if (!input || typeof input !== "string") {
    return null;
  }

  let value = input.trim();
  if (!value) {
    return null;
  }

  value = value.replace(/[\s()-]/g, "");

  if (value.startsWith("+")) {
    const digits = value.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }

  if (value.startsWith("00")) {
    const digits = value.slice(2).replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }

  const digits = value.replace(/\D/g, "");
  if (!digits) {
    return null;
  }

  if (digits.startsWith("0")) {
    return `${defaultCountryCode}${digits.slice(1)}`;
  }

  return `${defaultCountryCode}${digits}`;
}

export function maskPhoneNumber(number) {
  if (!number) {
    return "";
  }
  const visible = number.slice(-4);
  return `${"*".repeat(Math.max(0, number.length - 4))}${visible}`;
}
