//--------Dependencies-------//
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');

//--------Initialization--------//
const app = express()
const accessTokenSecret = 'carloebbasta';
const refreshTokenSecret = 'refreshcarloebbasta';
const H24 = 86400; // Indica i secondi in un giorno

// Elenco di refresh tokens contenenti quelli validi. Dal momento che il refresh token
// non scade mai (per non sbattere mai fuori gli utenti), scelto per ora di mantenere 
// la struttura in memoria, che quindi non sopravvive al riavvio del server, 
// il quale sbatte fuori tutti 
const refreshTokens = [];


app.use(bodyParser.json({ limit: '50mb' })); // Configurato per rimuovere il limite di dimensioni del pacchetto http che impediva la registrazione utente
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors()) //Utilizzo libreria CORS per configurare domini da cui ricevere chiamata (nel caso dell'app devo impostare ALL)

console.warn("App Avviata: versione " + process.env.VERSION);

//Authorization Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, accessTokenSecret, (err, user) => {
      if (err) {
        // Token non valido o scaduto, ritorno unauthorized
        return res.status(401).send('Invalid token');
      }

      req.user = user; // Imposto lo user nelle chiamate autenticate in modo che gli endpoint lo abbiano a disposizione
      next();
    });
  } else {
    res.status(401).send('No authorization header');
  }
};

//--------Routes Functions-------//

const getUsers = (request, response) => {
  pool.query('SELECT * FROM users', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows)
    }
  })
};

const addUser = (request, response) => {
  const { name, address, phoneNumber, birthDate, profilePhoto } = request.body

  console.log("Inserimento nuovo utente: " + request.body.name);

  pool.query('INSERT INTO users (name, address, phone_number, birth_date, profile_photo, created_on) VALUES ($1, $2, $3, $4, $5, $6)', [name, address, phoneNumber, birthDate, profilePhoto, new Date()], error => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(201).json({ status: 'success', message: 'User added.' })
    }
  })
};

const checkUserExists = (request, response) => {
  const { phone_number } = request.body;

  pool.query('SELECT count(*) FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows[0].count == 1)
    }
  })
};

const login = (req, res) => {
  const { phone_number } = req.body;
  console.warn('Login: ' + JSON.stringify(req.body));

  pool.query('SELECT * FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      user = results.rows[0];
      if (user) {
        // Aggiorno le informazioni sull'ultimo accesso dell'utente
        pool.query('UPDATE users SET last_login = $1 WHERE phone_number = $2', [new Date(), phone_number], (error, results) => {
          if (error) {
            console.warn(error);
            res.status(500).json({ message: 'errore query update last_login' });
          } else {
            // Genero le informazioni di sessione memorizzate nel token (rimuovo profile_photo)
            const userData = {
              userid: user.userid,
              name: user.name,
              address: user.address,
              phone_number: user.phone_number,
              birth_date: user.birth_date,
              refreshedOn: new Date()
            };
            // Genero access token e refresh token, impostando la durata a un giorno
            const accessToken = jwt.sign(userData, accessTokenSecret, { expiresIn: H24 });
            const refreshToken = jwt.sign(userData, refreshTokenSecret);
            refreshTokens.push(refreshToken); // Aggiungo il refreshToken alla lista in memoria, non sopravvive a riavvio server

            // Risposta contenente token e dati utente
            res.json({
              accessToken: accessToken,
              refreshToken: refreshToken,
              userData: user
            });
          }
        });
      } else {
        res.send('Incorrect credentials o.O');
      }
    }
  })
};

const refreshToken = (req, res) => {
  const refreshToken = req.body.refreshToken;

  if (!refreshTokens.includes(refreshToken)) {
    return res.status(404).send('Refresh token not found (server riavviato)');
  }

  // Verifico refresh token
  jwt.verify(refreshToken, refreshTokenSecret, (err, user) => {
    if (err) {
      return res.status(401).send('Invalid refresh token');
    }

    // Creo il nuovo access token modificando il valore refreshedOn per generarne uno
    // diverso, altrimenti la funzione 'sign' genererebbe lo stesso di prima già scaduto
    // Inoltre aumentata leggermente validità altrimenti per qualche motivo utilizzandolo
    // nasce scaduto
    user.refreshedOn = new Date();
    const newAccessToken = jwt.sign(user, accessTokenSecret, { expiresIn: H24 + 100 });

    res.json({
      accessToken: newAccessToken
    });
  });
};

const compareContacts = (request, response) => {
  const localContacts = request.body;
  const resContacts = [];

  if (localContacts.length > 0) {
    pool.query('SELECT * FROM users', (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        const dbContacts = results.rows;
        for (var i = 0; i < localContacts.length; i++) { // Per ogni utente su App
          for (var j = 0; j < dbContacts.length; j++) { // Per ogni utente su DB
            for (var x = 0; x < localContacts[i].phoneNumber.length; x++) { // Per ogni numero di telefono
              if (localContacts[i].phoneNumber[x] === dbContacts[j].phone_number && !resContacts.find(contact => contact.phoneNumber[0] === localContacts[i].phoneNumber[x])) { // Match e controllo se esiste già quel numero
                resContacts.push({ phoneNumber: localContacts[i].phoneNumber[x], name: dbContacts[j].name, imageUrl: dbContacts[j].profile_photo });
              }
            }
          }
        }
        response.status(200).json(resContacts);
      }
    });
  } else {
    console.warn('Ricevuto array di contatti vuoto');
    response.status(200).json(resContacts);
  }

};

const runQuery = (request, response) => {
  const query = request.body.query;

  console.warn("RunQuery: " + query);

  if (query) {
    pool.query(query, (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.warn("Results: " + JSON.stringify(results.rows));
        response.status(200).json(results.rows);
      }
    }
    );
  } else {
    console.warn('Empty query');
    response.status(400).json("Empty query");
  }
};

//--------Routes Definition-------//

//Users
app
  .route('/users')
  .get(authenticateJWT, getUsers) //[Non utilizzare] GET endpoint to list Users
  .post(addUser) // POST endpoint to signup user

//ExistsUser
app
  .route('/existsUser')
  .post(checkUserExists)

//Login
app.post('/login', login);

//RefreshToken
app.post('/refreshToken', refreshToken);

//Contacts
app
  .route('/compareContacts')
  .post(authenticateJWT, compareContacts);

//RunQuery
app
  .route('/runQuery')
  .post(authenticateJWT, runQuery);


// Start Server
app.listen(process.env.PORT || 1111, () => {
  console.log(`Server listening`)
})