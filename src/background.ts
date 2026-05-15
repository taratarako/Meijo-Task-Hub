import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

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

type ChromeIdentityApi = {
	getAuthToken: (details: { interactive: boolean }, callback: (token?: string) => void) => void;
};

type ChromeRuntimeApi = {
	lastError?: { message?: string };
	onMessage: {
		addListener: (
			callback: (message: SyncMessage, sender: unknown, sendResponse: (response: SyncResponse) => void) => boolean | void,
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
	const hours = work.dueTime?.hours ?? 23;
	const minutes = work.dueTime?.minutes ?? 59;
	// ClassroomのdueDate/dueTimeはローカル時刻として解釈する
	const localMs = new Date(dueDate.year, dueDate.month - 1, dueDate.day, hours, minutes, 0, 0).getTime();
	// 8時間早いズレを補正
	return localMs + 8 * 60 * 60 * 1000;
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

const upsertGoogleTask = async (task: {
	taskKey: string;
	course: string;
	title: string;
	description: string | null;
	endAtRaw: string;
	endAtMs: number | null;
	taskUrl: string | null;
	courseId: string;
	taskId: string;
}) => {
	await setDoc(
		doc(db, "tasks", task.taskKey),
		{
			course: task.course,
			title: task.title,
			description: task.description,
			endAt: task.endAtRaw,
			endAtMs: task.endAtMs,
			taskUrl: task.taskUrl,
			courseId: task.courseId,
			taskId: task.taskId,
			source: "GoogleClassroom",
			updatedAt: serverTimestamp(),
		},
		{ merge: true },
	);
};

const syncGoogleClassroom = async (interactive: boolean): Promise<SyncResponse> => {
	const token = await getAuthToken(interactive);
	const courses = await fetchAllCourses(token);
	let synced = 0;

	for (const course of courses) {
		const works = await fetchCourseWork(token, course);
		for (const work of works) {
			if (!work.id) continue;
			const endAtMs = toDueMs(work);
			await upsertGoogleTask({
				taskKey: `gclass_${course.id}_${work.id}`,
				course: course.name,
				title: work.title?.trim() || "無題課題",
				description: work.description?.trim() || null,
				endAtRaw: formatDueLabel(endAtMs),
				endAtMs,
				taskUrl: work.alternateLink ?? null,
				courseId: course.id,
				taskId: work.id,
			});
			synced += 1;
		}
	}

	return { ok: true, message: `Google Classroom同期: ${synced}件`, synced };
};

extensionChrome?.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type !== "mth-sync-google-classroom") return false;

	void syncGoogleClassroom(Boolean(message.interactive))
		.then((result) => sendResponse(result))
		.catch((error) => {
			const messageText = error instanceof Error ? error.message : "Google Classroom同期に失敗しました";
			sendResponse({ ok: false, message: messageText, synced: 0 } satisfies SyncResponse);
		});

	return true;
});