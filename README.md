npm run start:dev -> start local node server che riparte a ogni modifica sulla porta 1111
heroku local web -> start local server node che emula l'ambiente su heroku
heroku logs --tail -> visualizza ultime righe del log di Node

ENDPOINT: https://runningdinnerapi.herokuapp.com
ENDPOINT LOCALE: http://localhost:1111

Info utili:

- Negli endpoint autenticati la property 'user' di 'req' rappresenta l'utente loggato e può essere utilizzata per evitare di passare parametri già inclusi nel token
- Il refresh token non sopravvive a un riavvio del server (o deploy su heroku), quindi sicuramente bisogna rifare il login