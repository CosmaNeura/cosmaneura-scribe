"""Calibrate real TCP delay/reset/recovery against an owned synthetic endpoint."""
import json
import time
import urllib.error
import urllib.request

ADMIN = 'http://127.0.0.1:8479'


def api(path, body=None, method=None):
    req = urllib.request.Request(ADMIN + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'}, method=method)
    with urllib.request.urlopen(req, timeout=5) as response:
        data = response.read()
        return json.loads(data) if data else None


def measure():
    start = time.monotonic()
    with urllib.request.urlopen('http://127.0.0.1:18081/', timeout=3) as response:
        assert response.status == 200
        response.read()
    return round((time.monotonic() - start) * 1000, 2)


def main():
    proxies = api('/proxies')
    for name, listen, upstream in [('scribe_lab_http', '0.0.0.0:18081', 'echo:8000'),
                                   ('scribe_lab_db', '0.0.0.0:15432', 'postgres:5432')]:
        if name in proxies:
            assert proxies[name]['listen'] in (listen, listen.replace('0.0.0.0', '[::]'))
            assert proxies[name]['upstream'] == upstream
            api('/proxies/' + name, method='DELETE')
        api('/proxies', {'name': name, 'listen': listen, 'upstream': upstream})
    path = '/proxies/scribe_lab_http'
    result = {'scope': 'local real TCP harness calibration', 'baseline_ms': measure()}
    try:
        api(path + '/toxics', {'name': 'delay', 'type': 'latency', 'stream': 'downstream',
                              'toxicity': 1, 'attributes': {'latency': 250, 'jitter': 0}})
        result['delayed_ms'] = measure()
        assert result['delayed_ms'] >= 240
        api(path + '/toxics/delay', method='DELETE')
        api(path, {'enabled': False})
        try:
            measure()
        except (urllib.error.URLError, ConnectionError):
            result['disconnect_detected'] = True
        else:
            raise AssertionError('disabled proxy unexpectedly responded')
    finally:
        for toxic in api(path + '/toxics'):
            api(path + '/toxics/' + toxic['name'], method='DELETE')
        api(path, {'enabled': True})
    result['recovered_ms'] = measure()
    result['passed'] = True
    print(json.dumps(result))


if __name__ == '__main__':
    main()
