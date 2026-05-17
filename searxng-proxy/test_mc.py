import socket
s = socket.socket()
s.settimeout(5)
s.connect(('104.208.99.17', 10003))
data = b'\xfe\x01'
s.send(data)
try:
    resp = s.recv(4096)
    print('Response length:', len(resp))
    if resp:
        print('First bytes:', resp[:50])
        print('MC server is reachable through FRP!')
except socket.timeout:
    print('No response (timeout) - MC server may not be running locally')
s.close()
