# jpmtfilter

## usage

```
Usage:
  node app.ts [OPTION]

Options:
      --mode=spawned|socket     (default: socket)
      --listen-port=PORT        (default: 10025)
      --next-hop=HOST:PORT
      --next-hop-host=HOST
      --next-hop-port=PORT
      --handler-file=PATH
      --handler-url=URL
  -h, --help                    display this help
```

### postfix

master.cf

```
submission inet n       -       n       -       -       smtpd
...
  -o milter_macro_daemon_name=ORIGINATING
# spawn mode
  -o content_filter=jpmtfilter
# socket mode
  -o content_filter=jpmtfilter:[FILTER_HOST]:FILTER_PORT

# spawn mode
127.0.0.1:10025 inet n  n       n       -       0      spawn
  user=jpmtfilter argv=JPMTFILTER --mode=spawned --next-hop=127.0.0.1:10026 --handler-url=...

# socket mode
jpmtfilter unix   y     y       n       -       0       smtp
  -o smtp_send_xforward_command=yes
  -o disable_mime_output_conversion=yes
  -o smtp_generic_maps=
  -o smtp_use_tls=no
  -o smtp_tls_security_level=none

127.0.0.1:10026 inet  n       -       n       -       10      smtpd
  -o content_filter=
  -o receive_override_options=no_unknown_recipient_checks,no_header_body_checks,no_milters
  -o smtpd_helo_restrictions=
  -o smtpd_client_restrictions=
  -o smtpd_sender_restrictions=
  # Postfix 2.10 and later: specify empty smtpd_relay_restrictions.
  -o smtpd_relay_restrictions=
  -o smtpd_recipient_restrictions=permit_mynetworks,reject
  -o mynetworks=127.0.0.0/8
  -o smtpd_authorized_xforward_hosts=127.0.0.0/8
```