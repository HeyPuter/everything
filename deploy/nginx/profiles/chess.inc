# Mirrors src/chess/customHttp.yml (and the chess entry in root customHttp.yml).
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://js.puter.com https://plausible.io 'sha256-Ae92DMlvhX2of26U5jhemEEtmQDwlfAX4yVGQ8Mrsfc=' 'sha256-s3GjtVo80AO5y21xNb09L193qY2mDVWzcLbCiBHrn4s='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.puter.com https://puter.com https://js.puter.com https://plausible.io wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors *; upgrade-insecure-requests" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
