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
    setStatus(`連携に失敗しました: ${error.message}`, "error");
  }
}

function registerEvents() {
  elements.refreshSessionButton.addEventListener("click", () => {
    loadSession().catch((error) => {
      setStatus(`更新に失敗しました: ${error.message}`, "error");
    });
  });

  elements.phoneForm.addEventListener("submit", (event) => {
    submitPhoneLink(event);
  });

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
  state.lineUserId = resolveLineUserIdFromQuery();
  renderIdentity();

  try {
    await loadPublicConfig();
  } catch (error) {
    setStatus(`LINE設定の取得に失敗しました: ${error.message}`, "error");
    return;
  }

  await resolveLiffProfile();
  renderIdentity();

  try {
    await loadSession();
  } catch (error) {
    setStatus(`予約情報の取得に失敗しました: ${error.message}`, "error");
  }
}

bootstrap();
