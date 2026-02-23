const API_BASE =
  window.location.protocol === "file:" ? "http://localhost:18787" : "";

const elements = {
  addFriendButton: document.getElementById("add-friend-button"),
  openMiniAppButton: document.getElementById("open-miniapp-button"),
  liffLoginButton: document.getElementById("liff-login-button"),
  refreshSessionButton: document.getElementById("refresh-session-button"),
  statusMessage: document.getElementById("status-message"),
  lineUserId: document.getElementById("line-user-id"),
  linkedUserName: document.getElementById("linked-user-name"),
  phoneForm: document.getElementById("link-phone-form"),
  phoneInput: document.getElementById("phone-input"),
  createReservationForm: document.getElementById("create-reservation-form"),
  pickupStopSelect: document.getElementById("pickup-stop-select"),
  dropoffStopSelect: document.getElementById("dropoff-stop-select"),
  desiredDateInput: document.getElementById("desired-date-input"),
  desiredTimeInput: document.getElementById("desired-time-input"),
  createReservationButton: document.getElementById("create-reservation-button"),
  reservationCreateMessage: document.getElementById("reservation-create-message"),
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

function setButtonUrl(element, url) {
  if (!element) {
    return;
  }
  if (!url) {
    element.href = "#";
    element.setAttribute("aria-disabled", "true");
    return;
  }
  element.href = url;
  element.removeAttribute("aria-disabled");
}

function addLineUserIdQuery(url, lineUserId) {
  if (!url) {
    return "";
  }
  const base = new URL(url, window.location.origin);
  if (lineUserId) {
    base.searchParams.set("lineUserId", lineUserId);
  }
  return base.toString();
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
    throw new Error(payload.error || `GET ${path} failed (${response.status})`);
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
    throw new Error(payload.error || payload.status || `POST ${path} failed (${response.status})`);
  }
  return payload;
}

function renderIdentity() {
  elements.lineUserId.textContent = state.lineUserId || "未取得";
  if (state.session?.user?.name) {
    elements.linkedUserName.textContent = state.session.user.name;
    return;
  }
  if (state.displayName) {
    elements.linkedUserName.textContent = state.displayName;
    return;
  }
  elements.linkedUserName.textContent = "未連携";
}

function renderReservations(reservations) {
  elements.reservationList.innerHTML = "";
  if (!Array.isArray(reservations) || reservations.length === 0) {
    const item = document.createElement("li");
    item.className = "lr-reservation-item";
    item.innerHTML = `<p class="lr-reservation-title">予約はありません</p>`;
    elements.reservationList.appendChild(item);
    return;
  }

  reservations.forEach((reservation) => {
    const item = document.createElement("li");
    item.className = "lr-reservation-item";
    const primaryAt =
      reservation.plannedPickupAt ||
      reservation.desiredPickupAt ||
      reservation.desiredDropoffAt ||
      reservation.primaryTimeAt ||
      null;
    item.innerHTML = `
      <p class="lr-reservation-title">${reservation.statusLabel || reservation.status || "不明"}</p>
      <dl class="lr-reservation-meta">
        <div><strong>乗車:</strong> ${reservation.pickupLabel || "未設定"}</div>
        <div><strong>降車:</strong> ${reservation.dropoffLabel || "未設定"}</div>
        <div><strong>時刻:</strong> ${formatDateTime(primaryAt)}</div>
        <div><strong>予約ID:</strong> ${reservation.id || "-"}</div>
      </dl>
    `;
    elements.reservationList.appendChild(item);
  });
}

function renderSession(payload) {
  if (!payload) {
    elements.summaryText.textContent =
      "LINEユーザー情報が未取得です。LINEアプリ内で開くか、チャットの「予約確認」から遷移してください。";
    renderReservations([]);
    renderIdentity();
    return;
  }

  state.session = payload;
  elements.summaryText.textContent =
    payload.summaryText || "予約情報を取得しました。";
  renderReservations(payload.reservations);
  renderIdentity();
}

function applyPublicConfig(config) {
  state.config = {
    liffId: config?.liffId || "",
    miniAppUrl: config?.miniAppUrl || "",
    friendAddUrl: config?.friendAddUrl || "",
    officialAccountId: config?.officialAccountId || "",
  };
  setButtonUrl(elements.addFriendButton, state.config.friendAddUrl);
  setButtonUrl(
    elements.openMiniAppButton,
    addLineUserIdQuery(state.config.miniAppUrl, state.lineUserId)
  );
  elements.liffLoginButton.disabled = !state.config.liffId;
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

function resolveLineUserIdFromQuery() {
  const query = new URLSearchParams(window.location.search);
  return (query.get("lineUserId") || "").trim();
}

async function resolveLiffProfile() {
  if (state.lineUserId) {
    return;
  }
  if (!state.config.liffId) {
    setStatus(
      "LIFF IDが未設定です。友だち追加後にチャットのリンクから開いてください。",
      "warn"
    );
    return;
  }
  if (!window.liff) {
    setStatus("LIFF SDKの読み込みに失敗しました。", "error");
    return;
  }

  try {
    await window.liff.init({ liffId: state.config.liffId });
    if (!window.liff.isLoggedIn()) {
      setStatus("LINEログインでユーザー連携できます。", "warn");
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
          // ignore logout failure and continue with login prompt
        }
        state.lineUserId = "";
        state.displayName = "";
        setStatus(
          "LINEセッションの有効期限が切れました。LINEログインを押して再ログインしてください。",
          "warn"
        );
        return;
      }
      throw error;
    }
    state.lineUserId = profile?.userId || "";
    state.displayName = profile?.displayName || "";
    setStatus("LINEプロフィールを取得しました。", "ok");
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
  setButtonUrl(
    elements.openMiniAppButton,
    addLineUserIdQuery(state.config.miniAppUrl, state.lineUserId)
  );
  setStatus("予約情報を更新しました。", "ok");
}

async function submitPhoneLink(event) {
  event.preventDefault();
  const phoneNumber = elements.phoneInput.value.trim();
  if (!phoneNumber) {
    setStatus("電話番号を入力してください。", "warn");
    return;
  }
  if (!state.lineUserId) {
    setStatus("先にLINEユーザーを取得してください。", "warn");
    return;
  }

  try {
    const payload = await apiPost("/api/line/miniapp/link-phone", {
      lineUserId: state.lineUserId,
      phoneNumber,
      displayName: state.displayName || "",
    });
    renderSession(payload);
    setStatus("電話番号連携が完了しました。", "ok");
  } catch (error) {
    setStatus(`連携に失敗しました: ${getErrorMessage(error)}`, "error");
  }
}

async function submitCreateReservation(event) {
  event.preventDefault();
  setCreateMessage("", "info");

  if (!elements.pickupStopSelect || !elements.dropoffStopSelect) {
    setCreateMessage("予約フォームの初期化に失敗しました。ページを再読み込みしてください。", "error");
    return;
  }

  if (!state.lineUserId) {
    setStatus("先にLINEログインを実行してください。", "warn");
    return;
  }
  if (!elements.pickupStopSelect.value || !elements.dropoffStopSelect.value) {
    setCreateMessage("乗車バス停と降車バス停を選択してください。", "warn");
    return;
  }
  if (elements.pickupStopSelect.value === elements.dropoffStopSelect.value) {
    setCreateMessage("乗車バス停と降車バス停は別の停留所を選択してください。", "warn");
    return;
  }

  const desiredAt = buildDesiredAtIso(
    elements.desiredDateInput.value,
    elements.desiredTimeInput.value
  );
  if (!desiredAt) {
    setCreateMessage("希望日と希望時刻を正しく入力してください。", "warn");
    return;
  }

  const desiredMode = resolveDesiredMode();
  if (elements.createReservationButton) {
    elements.createReservationButton.disabled = true;
  }
  try {
    const payload = await apiPost("/api/line/miniapp/reservations", {
      lineUserId: state.lineUserId,
      displayName: state.displayName || "",
      pickupStopId: elements.pickupStopSelect.value,
      dropoffStopId: elements.dropoffStopSelect.value,
      desiredMode,
      desiredAt,
    });
    renderSession(payload);
    const reservationId = payload?.reservation?.id || "-";
    setCreateMessage(`予約を受け付けました（予約ID: ${reservationId}）`, "ok");
    setStatus("予約を登録しました。", "ok");
  } catch (error) {
    setCreateMessage(`予約の登録に失敗しました: ${getErrorMessage(error)}`, "error");
  } finally {
    if (elements.createReservationButton) {
      elements.createReservationButton.disabled = false;
    }
  }
}

function registerEvents() {
  elements.refreshSessionButton.addEventListener("click", () => {
    loadSession().catch((error) => {
      setStatus(`更新に失敗しました: ${getErrorMessage(error)}`, "error");
    });
  });

  elements.phoneForm.addEventListener("submit", (event) => {
    submitPhoneLink(event);
  });

  if (elements.createReservationForm) {
    elements.createReservationForm.addEventListener("submit", (event) => {
      submitCreateReservation(event);
    });
  }

  elements.liffLoginButton.addEventListener("click", () => {
    if (!window.liff || !state.config.liffId) {
      setStatus("LIFFが未設定です。", "warn");
      return;
    }
    if (window.liff.isLoggedIn()) {
      resolveLiffProfile()
        .then(() => loadSession())
        .catch((error) => {
          setStatus(`更新に失敗しました: ${getErrorMessage(error)}`, "error");
        });
      return;
    }
    window.liff.login({ redirectUri: window.location.href });
  });
}

async function bootstrap() {
  registerEvents();
  setDefaultDesiredDateTime();
  state.lineUserId = resolveLineUserIdFromQuery();
  renderIdentity();

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
  renderIdentity();

  try {
    await loadSession();
  } catch (error) {
    setStatus(`予約情報の取得に失敗しました: ${getErrorMessage(error)}`, "error");
  }
}

bootstrap();
