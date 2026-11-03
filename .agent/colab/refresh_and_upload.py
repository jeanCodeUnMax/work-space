import json, os, sys, urllib.request, urllib.parse

TOK = r'C:\Users\Administrator\.mcp-colab\token.json'
t = json.load(open(TOK))

data = urllib.parse.urlencode({
    'client_id': t['client_id'],
    'client_secret': t['client_secret'],
    'refresh_token': t['refresh_token'],
    'grant_type': 'refresh_token',
}).encode()
r = urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', data=data))
new = json.loads(r.read())
t.update(new)
json.dump(t, open(TOK, 'w'), indent=1)
at = new['access_token']
print('token refreshed')

BOUNDARY = 'colabupload'
def upload(local, name):
    meta = json.dumps({'name': name})
    body = (
        '--' + BOUNDARY + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n'
        '--' + BOUNDARY + '\r\nContent-Type: application/x-ipynb+json\r\n\r\n'
    ).encode() + open(local, 'rb').read() + ('\r\n--' + BOUNDARY + '--\r\n').encode()
    req = urllib.request.Request(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        data=body,
        headers={'Authorization': 'Bearer ' + at,
                 'Content-Type': 'multipart/related; boundary=' + BOUNDARY})
    resp = json.loads(urllib.request.urlopen(req).read())
    print('uploaded', name, '->', resp.get('id'))
    return resp.get('id')

base = r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\colab'
upload(os.path.join(base, 'comfyui-colab-ltxv.ipynb'), 'comfyui-colab-ltxv.ipynb')
upload(os.path.join(base, 'comfyui-colab-wan22.ipynb'), 'comfyui-colab-wan22.ipynb')
