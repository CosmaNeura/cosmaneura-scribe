import http from 'k6/http';
import { check } from 'k6';

// Local harness calibration only. Never label this endpoint native Record latency.
export const options = { vus: 1, iterations: 10,
  thresholds: { http_req_failed: ['rate==0'], http_req_duration: ['p(95)<1000'] } };
export default function () {
  check(http.get('http://toxiproxy:18081/'), { 'owned endpoint responds': r => r.status === 200 });
}
