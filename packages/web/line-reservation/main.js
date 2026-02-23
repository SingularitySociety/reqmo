const API_BASE =
  window.location.protocol === "file:" ? "http://localhost:18787" : "";

const elements = {
  guestHeroDescription: document.getElementById("guest-hero-description"),
  memberHeroDescription: document.getElementById("member-hero-description"),
  guestEntryPanel: document.getElementById("guest-entry-panel"),
  friendAddQrImage: document.getElementById("friend-add-qr-image"),
  friendAddFallbackLink: document.getElementById("friend-add-fallback-link"),
  lineSessionCard: document.getElementById("line-session-card"),
  reservationFormCard: document.getElementById("reservation-form-card"),
  reservationsCard: document.getElementById("reservations-card"),
  registrationCard: document.getElementById("registration-card"),
  toggleRegistrationButton: document.getElementById("toggle-registration-button"),
  refreshSessionButton: document.getElementById("refresh-session-button"),
  statusMessage: document.getElementById("status-message"),
  lineUserId: document.getElementById("line-user-id"),
  linkedUserName: document.getElementById("linked-user-name"),
  linkedPhoneNumber: document.getElementById("linked-phone-number"),
  linePhoneRegistrationMessage: document.getElementById("line-phone-registration-message"),
  registrationStatusText: document.getElementById("registration-status-text"),
  registerUserForm: document.getElementById("register-user-form"),
  registerNameInput: document.getElementById("register-name-input"),
  registerPhoneInput: document.getElementById("register-phone-input"),
  createReservationForm: document.getElementById("create-reservation-form"),
  pickupStopSelect: document.getElementById("pickup-stop-select"),
  dropoffStopSelect: document.getElementById("dropoff-stop-select"),
  desiredDateInput: document.getElementById("desired-date-input"),
  desiredTimeInput: document.getElementById("desired-time-input"),
  createReservationButton: document.getElementById("create-reservation-button"),
  reservationCreateMessage: document.getElementById("reservation-create-message"),
  reservationPreviewPanel: document.getElementById("reservation-preview-panel"),
  previewPickupLabel: document.getElementById("preview-pickup-label"),
  previewDropoffLabel: document.getElementById("preview-dropoff-label"),
  previewDesiredMode: document.getElementById("preview-desired-mode"),
  previewDesiredAt: document.getElementById("preview-desired-at"),
  previewPickupAt: document.getElementById("preview-pickup-at"),
  previewDropoffAt: document.getElementById("preview-dropoff-at"),
  previewMessage: document.getElementById("preview-message"),
  previewConsentCheckbox: document.getElementById("preview-consent-checkbox"),
  confirmReservationButton: document.getElementById("confirm-reservation-button"),
  clearPreviewButton: document.getElementById("clear-preview-button"),
  summaryText: document.getElementById("summary-text"),
  reservationList: document.getElementById("reservation-list"),
};

const state = {
  config: {
    liffId: "",
    miniAppUrl: "",
    friendAddUrl: "",
    officialAccountId: "",
  },
  lineUserId: "",
  displayName: "",
  session: null,
  stops: [],
  initialMode: "",
  showRegistrationEditor: false,
  pendingReservationInput: null,
};

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function isAccessTokenRevokedError(error) {
  return /access token revoked/i.test(getErrorMessage(error));
}

function setStatus(message, tone = "info") {
  if (!elements.statusMessage) {
    return;
  }
  elements.statusMessage.textContent = message || "";
  elements.statusMessage.dataset.tone = tone;
}

function setCreateMessage(message, tone = "info") {
  if (!elements.reservationCreateMessage) {
    return;
  }
  elements.reservationCreateMessage.textContent = message || "";
  elements.reservationCreateMessage.dataset.tone = tone;
}

function toDateInputText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputText(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function buildDesiredAtIso(dateText, timeText) {
  const dateValue = typeof dateText === "string" ? dateText.trim() : "";
  const timeValue = typeof timeText === "string" ? timeText.trim() : "";
  if (!dateValue || !timeValue) {
    return "";
  }
  const withSeconds = timeValue.length === 5 ? `${timeValue}:00` : timeValue;
  const parsed = new Date(`${dateValue}T${withSeconds}`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

function formatDateTime(value) {
  if (!value) {
    return "時刻未定";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "時刻未定";
  }
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatEstimateTime(value, etaMinutes) {
  if (value) {
    return formatDateTime(value);
  }
  if (Number.isFinite(Number(etaMinutes))) {
    return `約${Math.round(Number(etaMinutes))}分後`;
  }
  return "未算出";
}

function formatDesiredModeLabel(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "DROPOFF" ? "降車時刻基準" : "乗車時刻基準";
}

function escapeHtml(raw) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeStopList(rawStops) {
  if (!Array.isArray(rawStops)) {
    return [];
  }
  return rawStops
    .map((stop) => {
      const id = typeof stop?.id === "string" ? stop.id.trim() : "";
      if (!id) {
        return null;
      }
      const name = typeof stop?.name === "string" && stop.name.trim() ? stop.name.trim() : id;
      return { id, name };
    })
    .filter(Boolean);
}

function renderStopSelectOptions() {
  const selects = [elements.pickupStopSelect, elements.dropoffStopSelect];
  selects.forEach((select) => {
    if (!select) {
      return;
    }
    const previousValue = select.value;
    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "選択してください";
    select.appendChild(placeholder);

    state.stops.forEach((stop) => {
      const option = document.createElement("option");
      option.value = stop.id;
      option.textContent = stop.name;
      select.appendChild(option);
    });

    if (previousValue && state.stops.some((stop) => stop.id === previousValue)) {
      select.value = previousValue;
    }
  });
}

function setDefaultDesiredDateTime() {
  if (!elements.desiredDateInput || !elements.desiredTimeInput) {
    return;
  }
  const baseline = new Date();
  baseline.setMinutes(baseline.getMinutes() + 30, 0, 0);
  if (!elements.desiredDateInput.value) {
    elements.desiredDateInput.value = toDateInputText(baseline);
  }
  if (!elements.desiredTimeInput.value) {
    elements.desiredTimeInput.value = toTimeInputText(baseline);
  }
}

function resolveDesiredMode() {
  const selected = document.querySelector('input[name="desired-time-mode"]:checked');
  const value = selected && typeof selected.value === "string" ? selected.value.trim().toUpperCase() : "";
  return value === "DROPOFF" ? "DROPOFF" : "PICKUP";
}

function resolveInitialModeFromQuery() {
  const query = new URLSearchParams(window.location.search);
  return (query.get("mode") || "").trim().toLowerCase();
}

function resolveLineUserIdFromQuery() {
  const query = new URLSearchParams(window.location.search);
  return (query.get("lineUserId") || "").trim();
}

function buildOfficialAccountQrUrl(officialAccountId) {
  const normalized = typeof officialAccountId === "string" ? officialAccountId.trim() : "";
  const account = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (!account) {
    return "";
  }
  return `https://qr-official.line.me/gs/M_${encodeURIComponent(account)}_GW.png`;
}

function buildQrImageByFriendAddUrl(friendAddUrl) {
  const url = typeof friendAddUrl === "string" ? friendAddUrl.trim() : "";
  if (!url) {
    return "";
  }
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=png&data=${encodeURIComponent(url)}`;
}

function resolveGuestQrSources() {
  const officialQrUrl = buildOfficialAccountQrUrl(state.config.officialAccountId);
  const fallbackQrUrl = buildQrImageByFriendAddUrl(state.config.friendAddUrl);
  return {
    primary: officialQrUrl || fallbackQrUrl,
    fallback: fallbackQrUrl
  };
}

function setSectionVisibility(element, visible) {
  if (!element) {
    return;
  }
  element.hidden = !visible;
}

function updateConfirmReservationButtonState() {
  if (!elements.confirmReservationButton) {
    return;
  }
  const hasPreview = Boolean(state.pendingReservationInput);
  const hasConsent = Boolean(elements.previewConsentCheckbox?.checked);
  elements.confirmReservationButton.disabled = !(hasPreview && hasConsent);
}

function clearPreview() {
  state.pendingReservationInput = null;
  if (elements.reservationPreviewPanel) {
    elements.reservationPreviewPanel.hidden = true;
  }
  if (elements.previewConsentCheckbox) {
    elements.previewConsentCheckbox.checked = false;
  }
  updateConfirmReservationButtonState();
}

function renderGuestEntry() {
  const isGuest = !state.lineUserId;
  setSectionVisibility(elements.guestEntryPanel, isGuest);
  setSectionVisibility(elements.guestHeroDescription, isGuest);
  setSectionVisibility(elements.memberHeroDescription, !isGuest);
  if (!isGuest) {
    return;
  }

  const qrSource = resolveGuestQrSources();
  if (elements.friendAddQrImage) {
    elements.friendAddQrImage.src = qrSource.primary;
    elements.friendAddQrImage.hidden = !qrSource.primary;
    elements.friendAddQrImage.dataset.fallbackQr = qrSource.fallback || "";
  }
  if (elements.friendAddFallbackLink) {
    const url = state.config.friendAddUrl;
    const hasUrl = typeof url === "string" && url.trim();
    elements.friendAddFallbackLink.hidden = !hasUrl;
    elements.friendAddFallbackLink.href = hasUrl ? url.trim() : "#";
  }
}

function setReservationFormEnabled(enabled) {
  const controls = [
    elements.pickupStopSelect,
    elements.dropoffStopSelect,
    elements.desiredDateInput,
    elements.desiredTimeInput,
    elements.createReservationButton,
  ];
  controls.forEach((control) => {
    if (!control) {
      return;
    }
    control.disabled = !enabled;
  });
  if (!enabled) {
    clearPreview();
  }
}

function isRegistered() {
  return Boolean(state.session?.registration?.isRegistered);
}

function renderLayoutVisibility() {
  const authenticated = Boolean(state.lineUserId);
  setSectionVisibility(elements.lineSessionCard, authenticated);
  setSectionVisibility(elements.reservationFormCard, authenticated);
  setSectionVisibility(elements.reservationsCard, authenticated);
  renderGuestEntry();
}

function renderRegistrationStatus() {
  const registration = state.session?.registration || null;
  const registered = Boolean(registration?.isRegistered);
  const hasName = Boolean(registration?.hasName);
  const hasPhone = Boolean(registration?.hasPhone);

  if (elements.registrationStatusText) {
    if (!state.lineUserId) {
      elements.registrationStatusText.textContent = "";
      elements.registrationStatusText.dataset.tone = "info";
    } else if (registered) {
      const linkedPhone = registration?.normalizedPhoneE164 || "電話番号未取得";
      elements.registrationStatusText.textContent = `登録済みです（${linkedPhone}）`;
      elements.registrationStatusText.dataset.tone = "ok";
    } else {
      const missing = [];
      if (!hasName) {
        missing.push("名前");
      }
      if (!hasPhone) {
        missing.push("電話番号");
      }
      elements.registrationStatusText.textContent = `未登録です。${missing.join("・")}を入力して登録してください。`;
      elements.registrationStatusText.dataset.tone = "warn";
    }
  }

  if (elements.registerNameInput) {
    const currentName =
      (state.session?.registration?.userName || state.session?.user?.name || state.displayName || "").trim();
    if (currentName && !elements.registerNameInput.value) {
      elements.registerNameInput.value = currentName;
    }
  }
  if (elements.registerPhoneInput) {
    const currentPhone = (state.session?.registration?.normalizedPhoneE164 || "").trim();
    if (currentPhone && !elements.registerPhoneInput.value) {
      elements.registerPhoneInput.value = currentPhone;
    }
  }

  const shouldShowRegistrationCard =
    Boolean(state.lineUserId) && (!registered || state.showRegistrationEditor);
  setSectionVisibility(elements.registrationCard, shouldShowRegistrationCard);

  if (elements.toggleRegistrationButton) {
    const canToggle = Boolean(state.lineUserId) && registered;
    elements.toggleRegistrationButton.hidden = !canToggle;
    elements.toggleRegistrationButton.textContent = state.showRegistrationEditor
      ? "登録編集を閉じる"
      : "登録情報変更";
  }

  setReservationFormEnabled(Boolean(registered));
}

function renderIdentity() {
  if (elements.lineUserId) {
    elements.lineUserId.textContent = state.lineUserId || "未取得";
  }
  if (elements.linkedUserName) {
    if (state.session?.user?.name) {
      elements.linkedUserName.textContent = state.session.user.name;
    } else if (state.displayName) {
      elements.linkedUserName.textContent = state.displayName;
    } else {
      elements.linkedUserName.textContent = "未連携";
    }
  }

  const normalizedPhone = (state.session?.registration?.normalizedPhoneE164 || "").trim();
  const hasPhone = Boolean(state.session?.registration?.hasPhone) && Boolean(normalizedPhone);
  if (elements.linkedPhoneNumber) {
    elements.linkedPhoneNumber.textContent = hasPhone ? normalizedPhone : "未登録";
    elements.linkedPhoneNumber.dataset.tone = hasPhone ? "ok" : "warn";
  }
  if (elements.linePhoneRegistrationMessage) {
    const shouldWarn = Boolean(state.lineUserId) && !hasPhone;
    elements.linePhoneRegistrationMessage.hidden = !shouldWarn;
    elements.linePhoneRegistrationMessage.dataset.tone = shouldWarn ? "warn" : "info";
    elements.linePhoneRegistrationMessage.textContent = shouldWarn
      ? "電話番号が未登録です。利用者登録（必須）から電話番号を登録してください。"
      : "";
  }
}

function isReservationCancellable(reservation) {
  const status = typeof reservation?.status === "string" ? reservation.status.trim().toUpperCase() : "";
  return status && status !== "CANCELLED" && status !== "COMPLETED" && status !== "PICKED_UP";
}

function resolveReservationTone(status) {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (normalized === "CANCELLED") {
    return "cancelled";
  }
  if (normalized === "COMPLETED") {
    return "completed";
  }
  if (normalized === "ASSIGNED" || normalized === "PICKUP_PENDING" || normalized === "IN_PROGRESS") {
    return "active";
  }
  if (normalized === "REQUESTED") {
    return "waiting";
  }
  return "default";
}

function resolveDesiredSummary(reservation) {
  if (reservation?.desiredPickupAt) {
    return {
      label: "希望乗車",
      at: reservation.desiredPickupAt,
    };
  }
  if (reservation?.desiredDropoffAt) {
    return {
      label: "希望降車",
      at: reservation.desiredDropoffAt,
    };
  }
  return {
    label: "希望時刻",
    at: reservation?.primaryTimeAt || null,
  };
}

function resolvePickupScheduledAt(reservation) {
  return reservation?.plannedPickupAt || reservation?.desiredPickupAt || reservation?.primaryTimeAt || null;
}

function resolveDropoffScheduledAt(reservation) {
  return reservation?.plannedDropoffAt || reservation?.desiredDropoffAt || reservation?.primaryTimeAt || null;
}

function renderReservations(reservations) {
  if (!elements.reservationList) {
    return;
  }
  elements.reservationList.innerHTML = "";
  if (!Array.isArray(reservations) || reservations.length === 0) {
    const item = document.createElement("li");
    item.className = "lr-reservation-item lr-reservation-item-empty";
    item.innerHTML = `
      <p class="lr-reservation-empty-title">予約はありません</p>
      <p class="lr-reservation-empty-note">新規予約で条件を入力し、確認後に予約を作成してください。</p>
    `;
    elements.reservationList.appendChild(item);
    return;
  }

  reservations.forEach((reservation) => {
    const item = document.createElement("li");
    const tone = resolveReservationTone(reservation?.status);
    item.className = `lr-reservation-item lr-reservation-item--${tone}`;
    const desired = resolveDesiredSummary(reservation);
    const reservationIdRaw =
      typeof reservation?.id === "string" && reservation.id.trim() ? reservation.id.trim() : "-";
    const cancellable = isReservationCancellable(reservation) && reservationIdRaw !== "-";
    const reservationIdAttr = encodeURIComponent(reservationIdRaw);
    const statusLabel = escapeHtml(reservation.statusLabel || reservation.status || "不明");
    const reservationId = escapeHtml(reservationIdRaw);
    const pickupLabel = escapeHtml(reservation.pickupLabel || "未設定");
    const dropoffLabel = escapeHtml(reservation.dropoffLabel || "未設定");
    const desiredLabel = escapeHtml(desired.label);
    const desiredAt = escapeHtml(formatDateTime(desired.at));
    const plannedPickup = escapeHtml(formatDateTime(resolvePickupScheduledAt(reservation)));
    const plannedDropoff = escapeHtml(formatDateTime(resolveDropoffScheduledAt(reservation)));

    item.innerHTML = `
      <div class="lr-reservation-head">
        <p class="lr-reservation-title">${statusLabel}</p>
        <span class="lr-reservation-id">予約ID: ${reservationId}</span>
      </div>
      <div class="lr-reservation-route">
        <div class="lr-stop-block">
          <span class="lr-stop-chip lr-stop-chip-pickup">乗車</span>
          <strong>${pickupLabel}</strong>
        </div>
        <span class="lr-route-arrow">→</span>
        <div class="lr-stop-block">
          <span class="lr-stop-chip lr-stop-chip-dropoff">降車</span>
          <strong>${dropoffLabel}</strong>
        </div>
      </div>
      <dl class="lr-reservation-meta">
        <div><dt>${desiredLabel}</dt><dd>${desiredAt}</dd></div>
        <div><dt>乗車予定</dt><dd>${plannedPickup}</dd></div>
        <div><dt>降車予定</dt><dd>${plannedDropoff}</dd></div>
      </dl>
      ${
        cancellable
          ? `<div class="lr-reservation-actions"><button class="lr-button lr-button-danger lr-button-small" type="button" data-cancel-request-id="${reservationIdAttr}">この予約を取り消す</button></div>`
          : `<p class="lr-reservation-locked">この予約は取り消しできません。</p>`
      }
    `;
    elements.reservationList.appendChild(item);
  });
}

function renderPreviewPanel(preview) {
  if (!elements.reservationPreviewPanel) {
    return;
  }
  if (!preview) {
    clearPreview();
    return;
  }
  elements.reservationPreviewPanel.hidden = false;
  if (elements.previewPickupLabel) {
    elements.previewPickupLabel.textContent = preview.pickupLabel || "-";
  }
  if (elements.previewDropoffLabel) {
    elements.previewDropoffLabel.textContent = preview.dropoffLabel || "-";
  }
  if (elements.previewDesiredMode) {
    elements.previewDesiredMode.textContent = formatDesiredModeLabel(preview.desiredMode);
  }
  if (elements.previewDesiredAt) {
    elements.previewDesiredAt.textContent = formatDateTime(preview.desiredAt);
  }
  if (elements.previewPickupAt) {
    elements.previewPickupAt.textContent = formatEstimateTime(preview.plannedPickupAt, preview.etaPickupMinutes);
  }
  if (elements.previewDropoffAt) {
    elements.previewDropoffAt.textContent = formatEstimateTime(preview.plannedDropoffAt, preview.etaDropoffMinutes);
  }
  if (elements.previewMessage) {
    const suggestion = preview?.desiredDropoffSuggestion?.message || "";
    elements.previewMessage.textContent = suggestion
      ? `${suggestion} 確認後、「予約する」を押してください。`
      : "内容を確認し、同意チェック後に「予約する」を押してください。";
  }
  if (elements.previewConsentCheckbox) {
    elements.previewConsentCheckbox.checked = false;
  }
  updateConfirmReservationButtonState();
}

function renderSession(payload) {
  if (!payload) {
    state.session = null;
    if (elements.summaryText) {
      elements.summaryText.textContent =
        "LINE内リンクから開くと予約情報を表示します。";
    }
    renderReservations([]);
    renderIdentity();
    renderLayoutVisibility();
    renderRegistrationStatus();
    return;
  }

  state.session = payload;
  if (elements.summaryText) {
    elements.summaryText.textContent = payload.summaryText || "予約情報を取得しました。";
  }
  renderReservations(payload.reservations);
  renderIdentity();
  renderLayoutVisibility();
  renderRegistrationStatus();
}

function applyPublicConfig(config) {
  state.config = {
    liffId: config?.liffId || "",
    miniAppUrl: config?.miniAppUrl || "",
    friendAddUrl: config?.friendAddUrl || "",
    officialAccountId: config?.officialAccountId || "",
  };
  renderGuestEntry();
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      payload.message ||
        payload.error ||
        payload.reason ||
        payload.status ||
        `GET ${path} failed (${response.status})`
    );
  }
  return payload;
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      payload.message ||
        payload.error ||
        payload.reason ||
        payload.status ||
        `POST ${path} failed (${response.status})`
    );
  }
  return payload;
}

async function loadPublicConfig() {
  const payload = await apiGet("/api/line/public-config");
  applyPublicConfig(payload.config || {});
}

async function loadStops() {
  const payload = await apiGet("/api/stops");
  state.stops = normalizeStopList(payload.data);
  renderStopSelectOptions();
}

async function resolveLiffProfile() {
  if (state.lineUserId) {
    return;
  }
  if (!state.config.liffId || !window.liff) {
    return;
  }

  try {
    await window.liff.init({ liffId: state.config.liffId });
    if (!window.liff.isLoggedIn()) {
      return;
    }
    let profile = null;
    try {
      profile = await window.liff.getProfile();
    } catch (error) {
      if (isAccessTokenRevokedError(error)) {
        try {
          window.liff.logout();
        } catch {
          // ignore
        }
        state.lineUserId = "";
        state.displayName = "";
        setStatus("LINEセッションが失効しました。LINEチャットのリンクから開き直してください。", "warn");
        return;
      }
      throw error;
    }
    state.lineUserId = profile?.userId || "";
    state.displayName = profile?.displayName || "";
  } catch (error) {
    setStatus(`LIFF初期化に失敗: ${getErrorMessage(error)}`, "error");
  }
}

async function loadSession() {
  if (!state.lineUserId) {
    renderSession(null);
    return;
  }
  const query = new URLSearchParams({
    lineUserId: state.lineUserId,
  });
  if (state.displayName) {
    query.set("displayName", state.displayName);
  }

  const payload = await apiGet(`/api/line/miniapp/session?${query.toString()}`);
  renderSession(payload);
  setStatus("予約情報を更新しました。", "ok");
}

async function submitRegistration(event) {
  event.preventDefault();
  const name = elements.registerNameInput?.value?.trim() || "";
  const phoneNumber = elements.registerPhoneInput?.value?.trim() || "";
  if (!name || !phoneNumber) {
    setStatus("名前と電話番号を入力してください。", "warn");
    return;
  }
  if (!state.lineUserId) {
    setStatus("LINEユーザー情報が未取得です。LINE内リンクから再度開いてください。", "warn");
    return;
  }

  try {
    const payload = await apiPost("/api/line/miniapp/register", {
      lineUserId: state.lineUserId,
      name,
      phoneNumber,
      displayName: state.displayName || "",
    });
    state.showRegistrationEditor = false;
    renderSession(payload);
    setStatus("利用者登録を更新しました。", "ok");
  } catch (error) {
    setStatus(`利用者登録に失敗しました: ${getErrorMessage(error)}`, "error");
  }
}

function collectReservationInput() {
  if (!elements.pickupStopSelect || !elements.dropoffStopSelect) {
    throw new Error("予約フォームの初期化に失敗しました。");
  }
  if (!state.lineUserId) {
    throw new Error("LINEユーザー情報が未取得です。LINE内リンクから開き直してください。");
  }
  if (!isRegistered()) {
    throw new Error("予約前に利用者登録（名前・電話番号）を完了してください。");
  }
  if (!elements.pickupStopSelect.value || !elements.dropoffStopSelect.value) {
    throw new Error("乗車バス停と降車バス停を選択してください。");
  }
  if (elements.pickupStopSelect.value === elements.dropoffStopSelect.value) {
    throw new Error("乗車バス停と降車バス停は別の停留所を選択してください。");
  }
  const desiredAt = buildDesiredAtIso(
    elements.desiredDateInput?.value || "",
    elements.desiredTimeInput?.value || ""
  );
  if (!desiredAt) {
    throw new Error("希望日と希望時刻を正しく入力してください。");
  }

  return {
    lineUserId: state.lineUserId,
    displayName: state.displayName || "",
    pickupStopId: elements.pickupStopSelect.value,
    dropoffStopId: elements.dropoffStopSelect.value,
    desiredMode: resolveDesiredMode(),
    desiredAt,
  };
}

async function submitCreateReservation(event) {
  event.preventDefault();
  setCreateMessage("", "info");
  clearPreview();

  let input = null;
  try {
    input = collectReservationInput();
  } catch (error) {
    setCreateMessage(getErrorMessage(error), "warn");
    return;
  }

  if (elements.createReservationButton) {
    elements.createReservationButton.disabled = true;
  }
  try {
    const payload = await apiPost("/api/line/miniapp/reservations/preview", input);
    const preview = payload?.preview || null;
    if (!preview) {
      throw new Error("予想情報を取得できませんでした。");
    }
    state.pendingReservationInput = input;
    renderPreviewPanel(preview);
    setCreateMessage("予約可能です。確認欄をチェックしてから予約を確定してください。", "ok");
  } catch (error) {
    setCreateMessage(`予想の取得に失敗しました: ${getErrorMessage(error)}`, "error");
  } finally {
    if (elements.createReservationButton) {
      elements.createReservationButton.disabled = false;
    }
  }
}

async function confirmReservation() {
  if (!state.pendingReservationInput) {
    setCreateMessage("先に予想時刻を確認してください。", "warn");
    return;
  }
  if (!elements.previewConsentCheckbox?.checked) {
    setCreateMessage("確認チェックを入れてから予約してください。", "warn");
    return;
  }
  if (elements.confirmReservationButton) {
    elements.confirmReservationButton.disabled = true;
  }
  try {
    const payload = await apiPost("/api/line/miniapp/reservations", state.pendingReservationInput);
    renderSession(payload);
    const reservationId = payload?.reservation?.id || "-";
    clearPreview();
    setCreateMessage(`予約を受け付けました（予約ID: ${reservationId}）`, "ok");
    setStatus("予約を登録しました。", "ok");
  } catch (error) {
    setCreateMessage(`予約の登録に失敗しました: ${getErrorMessage(error)}`, "error");
  } finally {
    updateConfirmReservationButtonState();
  }
}

async function cancelReservationById(requestId) {
  const id = typeof requestId === "string" ? requestId.trim() : "";
  if (!id) {
    return;
  }
  if (!state.lineUserId) {
    setStatus("LINEユーザー情報が未取得です。", "warn");
    return;
  }
  const shouldCancel = window.confirm(`予約ID ${id} をキャンセルしますか？`);
  if (!shouldCancel) {
    return;
  }

  try {
    const payload = await apiPost(`/api/line/miniapp/reservations/${encodeURIComponent(id)}/cancel`, {
      lineUserId: state.lineUserId,
      displayName: state.displayName || "",
    });
    renderSession(payload);
    setStatus(`予約をキャンセルしました（${id}）`, "ok");
  } catch (error) {
    setStatus(`予約キャンセルに失敗しました: ${getErrorMessage(error)}`, "error");
  }
}

function registerEvents() {
  if (elements.refreshSessionButton) {
    elements.refreshSessionButton.addEventListener("click", () => {
      loadSession().catch((error) => {
        setStatus(`更新に失敗しました: ${getErrorMessage(error)}`, "error");
      });
    });
  }

  if (elements.toggleRegistrationButton) {
    elements.toggleRegistrationButton.addEventListener("click", () => {
      state.showRegistrationEditor = !state.showRegistrationEditor;
      renderRegistrationStatus();
    });
  }

  if (elements.registerUserForm) {
    elements.registerUserForm.addEventListener("submit", (event) => {
      submitRegistration(event);
    });
  }

  if (elements.createReservationForm) {
    elements.createReservationForm.addEventListener("submit", (event) => {
      submitCreateReservation(event);
    });
  }

  if (elements.confirmReservationButton) {
    elements.confirmReservationButton.addEventListener("click", () => {
      confirmReservation();
    });
  }

  if (elements.clearPreviewButton) {
    elements.clearPreviewButton.addEventListener("click", () => {
      clearPreview();
      setCreateMessage("予約条件を修正してください。", "info");
    });
  }

  if (elements.previewConsentCheckbox) {
    elements.previewConsentCheckbox.addEventListener("change", () => {
      updateConfirmReservationButtonState();
    });
  }

  if (elements.reservationList) {
    elements.reservationList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("[data-cancel-request-id]");
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const requestId = button.getAttribute("data-cancel-request-id");
      if (!requestId) {
        return;
      }
      let decodedId = requestId;
      try {
        decodedId = decodeURIComponent(requestId);
      } catch {
        decodedId = requestId;
      }
      cancelReservationById(decodedId);
    });
  }

  if (elements.friendAddQrImage) {
    elements.friendAddQrImage.addEventListener("error", () => {
      const fallbackQr = elements.friendAddQrImage.dataset.fallbackQr || "";
      if (fallbackQr && elements.friendAddQrImage.src !== fallbackQr) {
        elements.friendAddQrImage.src = fallbackQr;
        return;
      }
      elements.friendAddQrImage.hidden = true;
    });
  }
}

async function bootstrap() {
  registerEvents();
  updateConfirmReservationButtonState();
  setDefaultDesiredDateTime();
  state.initialMode = resolveInitialModeFromQuery();
  state.lineUserId = resolveLineUserIdFromQuery();
  renderLayoutVisibility();
  renderIdentity();
  renderRegistrationStatus();

  try {
    await loadPublicConfig();
  } catch (error) {
    setStatus(`LINE設定の取得に失敗しました: ${getErrorMessage(error)}`, "error");
    return;
  }

  try {
    await loadStops();
  } catch (error) {
    setCreateMessage(`バス停一覧の取得に失敗しました: ${getErrorMessage(error)}`, "error");
  }

  await resolveLiffProfile();
  renderLayoutVisibility();
  renderIdentity();

  try {
    await loadSession();
  } catch (error) {
    setStatus(`予約情報の取得に失敗しました: ${getErrorMessage(error)}`, "error");
  }

  if (!state.lineUserId) {
    setStatus("初めての方はQRコードから友だち追加してください。", "warn");
    return;
  }

  if (state.initialMode === "register") {
    state.showRegistrationEditor = true;
    renderRegistrationStatus();
    setStatus("登録情報を入力・更新してください。", "warn");
  } else if (state.initialMode === "reserve" && !isRegistered()) {
    setStatus("予約前に名前と電話番号の登録が必要です。", "warn");
  }
}

bootstrap();
