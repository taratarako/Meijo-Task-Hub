type GoogleCourse = {
	id: string;
	name: string;
};

type GoogleCourseWork = {
	id: string;
	title?: string;
	description?: string;
	alternateLink?: string;
	dueDate?: {
		year?: number;
		month?: number;
		day?: number;
	};
	dueTime?: {
		hours?: number;
		minutes?: number;
	};
};

type SyncMessage = {
	type: "mth-sync-google-classroom";
	interactive?: boolean;
};

type SyncResponse = {
	ok: boolean;
	message: string;
	synced: number;
};

type Calendar = {
	id: string;
	summary: string;
};

type CalendarsMessage = {
	type: "mth-get-calendars";
	interactive?: boolean;
};

type CalendarsResponse = {
	ok: boolean;
	message: string;
	calendars?: Calendar[];
};

type AuthTokenMessage = {
	type: "mth-get-auth-token";
	interactive?: boolean;
};

type AuthTokenResponse = {
	ok: boolean;
	message?: string;
	token?: string;
};

type AddEventMessage = {
	type: "mth-add-calendar-event";
	calendarId: string;
	task: {
		taskKey: string;
		title: string;
		endAtMs: number | null;
		course: string;
		taskUrl: string | null;
	};
	interactive?: boolean;
};

type AddEventResponse = {
	ok: boolean;
	message: string;
	eventId?: string;
};

type ChromeIdentityApi = {
	getAuthToken: (details: { interactive: boolean }, callback: (token?: string) => void) => void;
};

type ChromeRuntimeApi = {
	lastError?: { message?: string };
	onMessage: {
		addListener: (
			callback: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void,
		) => void;
	};
};

const extensionChrome = (globalThis as typeof globalThis & {
	chrome?: {
		identity?: ChromeIdentityApi;
		runtime?: ChromeRuntimeApi;
	};
}).chrome;

const CLASSROOM_COURSES_URL = "https://classroom.googleapis.com/v1/courses";
const CLASSROOM_WORK_URL = (courseId: string) =>
	`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork`;
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL = (calendarId: string) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

const getIdentity = () => {
	const identity = extensionChrome?.identity;
	if (!identity) throw new Error("chrome.identity が利用できません");
	return identity;
};

const getAuthToken = (interactive: boolean): Promise<string> =>
	new Promise((resolve, reject) => {
		getIdentity().getAuthToken({ interactive }, (token) => {
			const runtime = extensionChrome?.runtime;
			if (runtime?.lastError) {
				reject(new Error(runtime.lastError.message || "認証に失敗しました"));
				return;
			}
			if (!token) {
				reject(new Error("Google認証トークンを取得できませんでした"));
				return;
			}
			resolve(token);
		});
	});

const fetchAllCourses = async (token: string): Promise<GoogleCourse[]> => {
	let nextPageToken: string | undefined;
	const courses: GoogleCourse[] = [];

	do {
		const params = new URLSearchParams({ pageSize: "50", courseStates: "ACTIVE" });
		if (nextPageToken) params.set("pageToken", nextPageToken);

		const response = await fetch(`${CLASSROOM_COURSES_URL}?${params.toString()}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			throw new Error(`Classroomコース取得に失敗しました (${response.status})`);
		}

		const body = (await response.json()) as { courses?: GoogleCourse[]; nextPageToken?: string };
		if (body.courses) {
			courses.push(...body.courses.filter((course) => Boolean(course.id && course.name)));
		}
		nextPageToken = body.nextPageToken;
	} while (nextPageToken);

	return courses;
};

const toDueMs = (work: GoogleCourseWork): number | null => {
	const dueDate = work.dueDate;
	if (!dueDate?.year || !dueDate.month || !dueDate.day) return null;
	const hasTime = Boolean(work.dueTime);
	const hours = work.dueTime?.hours ?? 23;
	const minutes = work.dueTime?.minutes ?? (hasTime ? 0 : 59);
	// ClassroomのdueDate/dueTimeはUTCとして扱い、表示時にローカル変換する
	return Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, hours, minutes, 0, 0);
};

const formatDueLabel = (ms: number | null): string => {
	if (ms === null) return "期限なし";
	const date = new Date(ms);
	return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const fetchCourseWork = async (token: string, course: GoogleCourse): Promise<GoogleCourseWork[]> => {
	const params = new URLSearchParams({ pageSize: "50", courseWorkStates: "PUBLISHED" });
	const response = await fetch(`${CLASSROOM_WORK_URL(course.id)}?${params.toString()}`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (!response.ok) {
		throw new Error(`Classroom課題取得に失敗しました (${response.status})`);
	}

	const body = (await response.json()) as { courseWork?: GoogleCourseWork[] };
	return body.courseWork ?? [];
};

const syncGoogleClassroom = async (interactive: boolean): Promise<SyncResponse> => {
	const token = await getAuthToken(interactive);
	const courses = await fetchAllCourses(token);
	let synced = 0;

	for (const course of courses) {
		const works = await fetchCourseWork(token, course);
		for (const work of works) {
			if (!work.id) continue;
			void formatDueLabel(toDueMs(work));
			synced += 1;
		}
	}

	return { ok: true, message: `Google Classroom同期: ${synced}件 (保存なし)`, synced };
};

const getCalendarsList = async (token: string): Promise<Calendar[]> => {
	const response = await fetch(CALENDAR_LIST_URL, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (!response.ok) {
		throw new Error(`カレンダー一覧取得に失敗しました (${response.status})`);
	}

	const body = (await response.json()) as { items?: Array<{ id: string; summary: string }> };
	return (body.items ?? []).map((cal) => ({ id: cal.id, summary: cal.summary }));
};

const checkEventExists = async (token: string, calendarId: string, taskKey: string): Promise<boolean> => {
	try {
		const params = new URLSearchParams({
			q: taskKey,
			fields: "items/id",
			pageSize: "1",
		});

		const response = await fetch(`${CALENDAR_EVENTS_URL(calendarId)}?${params.toString()}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) return false;

		const body = (await response.json()) as { items?: Array<{ id: string }> };
		return (body.items ?? []).length > 0;
	} catch {
		return false;
	}
};

const createCalendarEvent = async (
	token: string,
	calendarId: string,
	task: {
		taskKey: string;
		title: string;
		endAtMs: number | null;
		course: string;
		taskUrl: string | null;
	},
): Promise<string> => {
	if (task.endAtMs === null) {
		throw new Error("締切がない課題はカレンダーに追加できません");
	}

	// 締切時刻ちょうどの1分イベント
	const endTime = new Date(task.endAtMs);
	const startTime = new Date(task.endAtMs - 60 * 1000); // 1分前

	const eventBody = {
		summary: `[${task.course}] ${task.title}`,
		description: task.taskUrl ? `タスク: ${task.taskUrl}` : undefined,
		start: { dateTime: startTime.toISOString() },
		end: { dateTime: endTime.toISOString() },
		extendedProperties: {
			private: {
				taskKey: task.taskKey,
			},
		},
	};

	const response = await fetch(CALENDAR_EVENTS_URL(calendarId), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(eventBody),
	});

	if (!response.ok) {
		throw new Error(`カレンダーイベント作成に失敗しました (${response.status})`);
	}

	const body = (await response.json()) as { id?: string };
	if (!body.id) throw new Error("イベント作成後にIDが返されませんでした");

	return body.id;
};

extensionChrome?.runtime?.onMessage.addListener((message: unknown, _sender, sendResponse: (response: unknown) => void) => {
	const msg = message as SyncMessage | CalendarsMessage | AddEventMessage | AuthTokenMessage;
	
	if (msg.type === "mth-sync-google-classroom") {
		void syncGoogleClassroom(Boolean(msg.interactive))
			.then((result) => sendResponse(result))
			.catch((error) => {
				const messageText = error instanceof Error ? error.message : "Google Classroom同期に失敗しました";
				sendResponse({ ok: false, message: messageText, synced: 0 } satisfies SyncResponse);
			});
		return true;
	}

	if (msg.type === "mth-get-calendars") {
		void (async () => {
			try {
				const token = await getAuthToken(Boolean(msg.interactive));
				const calendars = await getCalendarsList(token);
				sendResponse({ ok: true, message: "カレンダー一覧取得成功", calendars } satisfies CalendarsResponse);
			} catch (error) {
				const messageText = error instanceof Error ? error.message : "カレンダー一覧取得に失敗しました";
				sendResponse({ ok: false, message: messageText } satisfies CalendarsResponse);
			}
		})();
		return true;
	}

	if (msg.type === "mth-add-calendar-event") {
		void (async () => {
			try {
				const token = await getAuthToken(Boolean(msg.interactive));
				const exists = await checkEventExists(token, msg.calendarId, msg.task.taskKey);
				if (exists) {
					sendResponse({ ok: false, message: "このイベントは既に追加されています" } satisfies AddEventResponse);
					return;
				}
				const eventId = await createCalendarEvent(token, msg.calendarId, msg.task);
				sendResponse({ ok: true, message: "カレンダーに追加しました", eventId } satisfies AddEventResponse);
			} catch (error) {
				const messageText = error instanceof Error ? error.message : "カレンダーへの追加に失敗しました";
				sendResponse({ ok: false, message: messageText } satisfies AddEventResponse);
			}
		})();
		return true;
	}

	if (msg.type === "mth-get-auth-token") {
		void (async () => {
			try {
				const token = await getAuthToken(Boolean(msg.interactive));
				sendResponse({ ok: true, token } satisfies AuthTokenResponse);
			} catch (error) {
				const messageText = error instanceof Error ? error.message : "認証トークン取得に失敗しました";
				sendResponse({ ok: false, message: messageText } satisfies AuthTokenResponse);
			}
		})();
		return true;
	}

	return false;
});