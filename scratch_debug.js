import { gotScraping } from 'got-scraping';

const url = 'https://bcdnxw.hakunaymatata.com/resource/56488d5279820a3cfc3942c25d800400.mp4?sign=508540a81db1c430b477c522b1fd3bdf&t=1778226755';
const headers = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "origin": "https://vidrock.net",
  "referer": "https://vidrock.net/movie/1318447",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Google Chrome";v="147", "Not;A Brand";v="99", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "video",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site"
};

try {
  console.log('Fetching:', url);
  const response = await gotScraping({
    url,
    headers,
    timeout: { request: 5000 },
    retry: { limit: 0 },
    followRedirect: true
  });
  console.log('Status:', response.statusCode);
  console.log('Headers:', response.headers);
} catch (error) {
  console.error('Error:', error.message);
  if (error.response) {
    console.error('Response Status:', error.response.statusCode);
    console.error('Response Body:', error.response.body.slice(0, 500));
  }
}
