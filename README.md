npm run start:dev -> start local node server che riparte a ogni modifica sulla porta 1111
heroku local web -> start local server node che emula l'ambiente su heroku
heroku logs --tail -> visualizza ultime righe del log di Node
heroku restart -> riavvia il server runningdinnerapi, utile in caso di crash non gestito per evitare il commit
heroku ps:scale web=0 -> stoppa il server di Heroku
heroku ps:scale web=1 -> riattiva il server di Heroku.

ENDPOINT: https://runningdinnerapi.herokuapp.com
ENDPOINT LOCALE: http://localhost:1111

Info utili:

- Negli endpoint autenticati la property 'user' di 'req' rappresenta l'utente loggato e può essere utilizzata per evitare di passare parametri già inclusi nel token
- Il refresh token non sopravvive a un riavvio del server (o deploy su heroku), quindi sicuramente bisogna rifare il login dopo che l'access token è scaduto. Per causare un logout al riavvio server bisogna implementare un array in memoria che tenga le sessioni attive, e nella verifica del token fare come il refresh verificando che il token sia all'interno prima di verificarlo tramite algoritmo