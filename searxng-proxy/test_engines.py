import requests
engines = ['google','bing','duckduckgo','brave','qwant','startpage','mojeek','ecosia','yandex','yahoo']
for e in engines:
    try:
        r = requests.get('http://localhost:8889/search', params={'q':'python flask','format':'json','engines':e}, timeout=15)
        d = r.json()
        n = len(d.get('results',[]))
        print(f'{e}: {n} results')
    except Exception as ex:
        print(f'{e}: error - {ex}')
