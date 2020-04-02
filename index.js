//--------Dependencies-------//
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');

//--------Initialization--------//
const app = express()
const accessTokenSecret = 'carloebbasta';
/* const refreshTokenSecret = 'refreshcarloebbasta';
const refreshTokens = []; */
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
        return res.sendStatus(403);
      }

      req.user = user;
      next();
    });
  } else {
    res.sendStatus(401);
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
            // Generate an access token
            const accessToken = jwt.sign({ username: user.username, role: user.role }, accessTokenSecret);
            // Risposta contenente token e dati utente
            res.json({
              accessToken: accessToken,
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
          console.warn(localContacts[i]);
          for (var j = 0; j < dbContacts.length; j++) { // Per ogni utente su DB
            if (localContacts[i].phoneNumber == dbContacts[j].phone_number) { // Match
              resContacts.push({ phoneNumber: localContacts[i].phoneNumber });
            }
          }
        }
      }
      response.status(200).json(resContacts);
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
app
  .post('/login', login);

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