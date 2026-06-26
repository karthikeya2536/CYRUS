const today = new Date();
today.setHours(0, 0, 0, 0);
const timeMin = today.toISOString();
const timeMaxDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
const timeMax = timeMaxDate.toISOString();
const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=50&orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
console.log(url);
