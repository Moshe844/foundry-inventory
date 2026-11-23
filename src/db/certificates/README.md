The public Ohio RDS root bundle was downloaded over verified HTTPS on November 23, 2026 from:

https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem

SHA-256: `d46e1bdfda05c8e7644e50930806a19b139a222542bf0348082fb59ece2b5fa5`

It contains three self-signed CA roots (RSA2048 G1, RSA4096 G1, ECC384 G1), not database credentials or private keys. TLS still validates the endpoint hostname and certificate chain. Review and update the bundle/hash with AWS CA rotations; never turn off certificate verification to repair a connection.

Source: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
