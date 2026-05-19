export type ExtractedTask = {
  taskKey: string;
  course: string;
  title: string;
  endAtRaw: string;
  endAtMs: number | null;
  taskUrl: string | null;
  courseId: string | null;
  taskId: string | null;
  source: "WebClass_AutoSync" | "GoogleClassroom";
  hidden?: boolean;
  hiddenUntil?: number | null;
  hiddenAt?: number | null;
};

export type Calendar = {
  id: string;
  summary: string;
};

export type CalendarListResponse = {
  ok?: boolean;
  message?: string;
  calendars?: Calendar[];
};

export type AddCalendarEventResponse = {
  ok?: boolean;
  message?: string;
};

export type GoogleSyncResponse = {
  ok?: boolean;
  message?: string;
};
